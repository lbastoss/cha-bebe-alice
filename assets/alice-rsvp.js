(function () {
  const config = window.ALICE_RSVP_CONFIG || {};
  const eventDate = new Date(config.eventDate || "2026-08-15T12:00:00-03:00");
  const storageKey = config.storageKey || "alice-cha-bebe-rsvps";
  const scriptUrl = config.googleScriptUrl || "";
  const diaperSuggestionCacheKey = "alice-diaper-suggestion-cache";

  const DIAPER_MEMORY_CACHE_TIME = 60 * 1000;
  const DIAPER_REQUEST_TIMEOUT = 6000;

  let diaperSuggestionRequest = null;
  let memoryDiaperSuggestion = null;
  let memoryDiaperSuggestionAt = 0;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function readDiaperSuggestionCache() {
    try {
      const cached = JSON.parse(
        localStorage.getItem(diaperSuggestionCacheKey) || "null"
      );

      if (!cached || !cached.tamanho) {
        return null;
      }

      return {
        tamanho: String(cached.tamanho).trim().toUpperCase(),
        origem: "cache-planilha",
        savedAt: Number(cached.savedAt || 0),
      };
    } catch (_) {
      return null;
    }
  }

  function saveDiaperSuggestionCache(suggestion) {
    if (!suggestion || !suggestion.tamanho) {
      return;
    }

    const cached = {
      tamanho: String(suggestion.tamanho).trim().toUpperCase(),
      savedAt: Date.now(),
    };

    try {
      localStorage.setItem(
        diaperSuggestionCacheKey,
        JSON.stringify(cached)
      );
    } catch (_) {
      // O site continua funcionando mesmo se o navegador bloquear localStorage.
    }
  }

  function setCountdown() {
    const now = new Date();
    const diff = eventDate.getTime() - now.getTime();
    const grid = $("[data-countdown-grid]");
    const done = $("[data-countdown-done]");

    if (diff <= 0) {
      if (grid) grid.hidden = true;
      if (done) done.hidden = false;
      return;
    }

    if (grid) grid.hidden = false;
    if (done) done.hidden = true;

    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);

    $$('[data-countdown="days"]').forEach((node) => {
      node.textContent = String(days);
    });
    $$('[data-countdown="hours"]').forEach((node) => {
      node.textContent = pad(hours);
    });
    $$('[data-countdown="minutes"]').forEach((node) => {
      node.textContent = pad(minutes);
    });
    $$('[data-countdown="seconds"]').forEach((node) => {
      node.textContent = pad(seconds);
    });
  }

  function readLocalRows() {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || "[]");
    } catch (_) {
      return [];
    }
  }

  function writeLocalRow(row) {
    const rows = readLocalRows();
    rows.unshift(row);
    localStorage.setItem(storageKey, JSON.stringify(rows.slice(0, 250)));
  }

  function statusLabel(value) {
    return {
      confirmed: "Confirmado",
      declined: "Não vai",
    }[value] || value;
  }

  function giftLabel(value) {
    return {
      fralda: "Fralda",
      mimo: "Mimo à escolha",
    }[value] || "";
  }

  function getFormPayload(form) {
    const formData = new FormData(form);
    const status = String(formData.get("status") || "confirmed");
    const adults = Math.max(Number(formData.get("adults") || 0), 0);
    const children = Math.max(Number(formData.get("children") || 0), 0);
    const attending = status !== "declined";
    const total = attending ? adults + children : 0;
    const giftType = String(formData.get("giftType") || "fralda");
    const diaperSize = String(formData.get("diaperSize") || "").trim();

    return {
      timestamp: new Date().toISOString(),
      babyName: "Alice",
      eventDate: eventDate.toISOString(),
      sourcePage: config.modelName || document.title,
      name: String(formData.get("name") || "").trim(),
      phone: String(formData.get("phone") || "").trim(),
      status: statusLabel(status),
      statusKey: status,
      adults,
      children,
      total,
      notes: String(formData.get("notes") || "").trim(),
      giftTypeKey: attending ? giftType : "",
      presente: attending ? giftLabel(giftType) : "",
      tamanhoFralda: attending && giftType === "fralda" ? diaperSize : "",
      website: String(formData.get("website") || ""),
    };
  }

  function updateFormState(form) {
    const payload = getFormPayload(form);
    const totalNode = $("[data-total]", form);
    const attendanceInputs = $$('[data-attendance-count]', form);
    const declined = payload.statusKey === "declined";

    attendanceInputs.forEach((input) => {
      input.disabled = declined;
      input.closest(".field")?.classList.toggle("is-disabled", declined);
    });

    if (totalNode) {
      totalNode.textContent = String(payload.total);
    }

    const giftSection = $("[data-gift-section]", form);
    const diaperBox = $("[data-diaper-suggestion]", form);
    const diaperInput = $("[data-diaper-size-input]", form);

    if (giftSection) {
      giftSection.classList.toggle("is-hidden", declined);
      giftSection.hidden = declined;
    }

    const showDiaperBox = !declined && payload.giftTypeKey === "fralda";

    if (diaperBox) {
      diaperBox.hidden = !showDiaperBox;
      diaperBox.classList.toggle("is-hidden", !showDiaperBox);
    }

    if (!showDiaperBox && diaperInput) {
      diaperInput.value = "";
    }

    $$("[data-radio-pill]", form).forEach((label) => {
      const input = label.querySelector("input");
      label.classList.toggle("is-checked", Boolean(input?.checked));
    });

    return { declined, showDiaperBox };
  }

  async function fetchDiaperSuggestion(options = {}) {
    const forceRefresh = Boolean(options.forceRefresh);
    const hasEndpoint =
      scriptUrl &&
      !scriptUrl.includes("COLE_AQUI") &&
      /^https?:\/\//i.test(scriptUrl);

    const memoryCacheIsValid =
      !forceRefresh &&
      memoryDiaperSuggestion &&
      Date.now() - memoryDiaperSuggestionAt < DIAPER_MEMORY_CACHE_TIME;

    if (memoryCacheIsValid) {
      return memoryDiaperSuggestion;
    }

    if (diaperSuggestionRequest) {
      return diaperSuggestionRequest;
    }

    if (!hasEndpoint) {
      return readDiaperSuggestionCache() || { tamanho: "", origem: "sem-endpoint" };
    }

    diaperSuggestionRequest = (async function () {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => {
        controller.abort();
      }, DIAPER_REQUEST_TIMEOUT);

      try {
        const separator = scriptUrl.includes("?") ? "&" : "?";
        const response = await fetch(
          `${scriptUrl}${separator}action=sugestaoFralda&_=${Date.now()}`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          throw new Error("Não foi possível consultar a planilha.");
        }

        const data = await response.json();

        if (!data || !data.ok || !data.tamanho) {
          throw new Error("A planilha não retornou um tamanho válido.");
        }

        const suggestion = {
          tamanho: String(data.tamanho).trim().toUpperCase(),
          origem: "planilha",
        };

        memoryDiaperSuggestion = suggestion;
        memoryDiaperSuggestionAt = Date.now();
        saveDiaperSuggestionCache(suggestion);

        return suggestion;
      } catch (_) {
        return readDiaperSuggestionCache() || { tamanho: "", origem: "erro" };
      } finally {
        window.clearTimeout(timeout);
        diaperSuggestionRequest = null;
      }
    })();

    return diaperSuggestionRequest;
  }

  function applySuggestionToForm(form, suggestion) {
    if (!suggestion || !suggestion.tamanho) {
      return false;
    }

    const box = $("[data-diaper-suggestion]", form);
    const textNode = $("[data-diaper-size-text]", form);
    const hiddenInput = $("[data-diaper-size-input]", form);

    if (!box || box.hidden) {
      return false;
    }

    if (textNode) {
      textNode.textContent = `Sugerimos 1 pacote de fraldas tamanho ${suggestion.tamanho}`;
    }

    if (hiddenInput) {
      hiddenInput.value = suggestion.tamanho;
    }

    box.dataset.origin = suggestion.origem || "planilha";
    return true;
  }

  async function refreshDiaperSuggestion(form, options = {}) {
    const box = $("[data-diaper-suggestion]", form);
    const textNode = $("[data-diaper-size-text]", form);
    const hiddenInput = $("[data-diaper-size-input]", form);
    const selectedGift = $('input[name="giftType"]:checked', form)?.value;
    const status = $("#status", form)?.value;

    const shouldShowSuggestion =
      status !== "declined" && selectedGift === "fralda";

    if (!box || !shouldShowSuggestion || box.hidden) {
      if (hiddenInput) hiddenInput.value = "";
      return null;
    }

    const cached = readDiaperSuggestionCache();

    if (cached) {
      applySuggestionToForm(form, cached);
    } else {
      if (textNode) textNode.textContent = "Consultando estoque…";
      if (hiddenInput) hiddenInput.value = "";
      box.dataset.origin = "consultando";
    }

    const suggestion = await fetchDiaperSuggestion(options);

    const stillWantsDiaper =
      $("#status", form)?.value !== "declined" &&
      $('input[name="giftType"]:checked', form)?.value === "fralda" &&
      !box.hidden;

    if (!stillWantsDiaper) {
      if (hiddenInput) hiddenInput.value = "";
      return null;
    }

    if (!suggestion || !suggestion.tamanho) {
      if (!cached) {
        if (textNode) {
          textNode.textContent = "Não foi possível consultar o estoque agora.";
        }
        if (hiddenInput) hiddenInput.value = "";
      }
      return cached;
    }

    applySuggestionToForm(form, suggestion);
    return suggestion;
  }

  async function sendPayload(payload) {
    const hasEndpoint =
      scriptUrl &&
      !scriptUrl.includes("COLE_AQUI") &&
      /^https?:\/\//i.test(scriptUrl);

    if (!hasEndpoint) {
      throw new Error(
        "A URL do Google Apps Script não está configurada."
      );
    }

    await fetch(scriptUrl, {
      method: "POST",
      mode: "no-cors",
      body: JSON.stringify(payload),
    });

    return {
      mode: "google-sheets",
    };
  }



  function setView(dialog, viewName) {
    $$('[data-view]', dialog).forEach((node) => {
      node.hidden = node.dataset.view !== viewName;
    });
  }

  function fillSuccessView(dialog, payload) {
    const icon = $("[data-success-icon]", dialog);
    const title = $("[data-success-title]", dialog);
    const message = $("[data-success-message]", dialog);
    const giftRow = $("[data-gift-row]", dialog);
    const giftText = $("[data-gift-text]", dialog);
    const followup = $("[data-success-followup]", dialog);
    const dialogTitle = $("[data-dialog-title]", dialog);
    const declined = payload.statusKey === "declined";

    if (dialogTitle) dialogTitle.textContent = declined ? "Combinado" : "Confirmação";
    if (icon) icon.textContent = declined ? "💛" : "🎉";
    if (title) {
      title.textContent = declined
        ? "Tudo bem, obrigado por avisar!"
        : "Presença confirmada!";
    }
    if (message) {
      message.textContent = declined
        ? "Sentiremos sua falta, mas agradecemos muito por nos contar com antecedência."
        : "Mal podemos esperar para te ver na festa da Alice.";
    }

    if (giftRow && giftText) {
      if (declined || !payload.presente) {
        giftRow.hidden = true;
      } else {
        giftRow.hidden = false;
        giftText.textContent = payload.tamanhoFralda
          ? `1 pacote de fraldas tamanho ${payload.tamanhoFralda}`
          : payload.presente;
      }
    }

    if (followup) {
      followup.hidden = declined;
    }
  }

  function formatBrazilianPhone(value) {
    const digits = String(value || "")
      .replace(/\D/g, "")
      .slice(0, 11);

    if (!digits) return "";
    if (digits.length <= 2) return `(${digits}`;

    const ddd = digits.slice(0, 2);
    const number = digits.slice(2);

    if (number.length <= 4) {
      return `(${ddd}) ${number}`;
    }

    if (number.length <= 8) {
      return `(${ddd}) ${number.slice(0, 4)}-${number.slice(4)}`;
    }

    return `(${ddd}) ${number.slice(0, 5)}-${number.slice(5, 9)}`;
  }

  function setupDialog() {
    const dialog = $("#rsvpDialog");
    const form = $("#rsvpForm");
    if (!dialog || !form) return;

    const nameInput = $("#name", form);
    const phoneInput = $("#phone", form);
    const statusNode = $("[data-form-status]", form);
    const submitButton = $('button[type="submit"]', form);

    nameInput?.addEventListener("input", function () {
      this.value = this.value
        .replace(/[^A-Za-zÀ-ÖØ-öø-ÿ'´\-\s]/g, "")
        .replace(/\s{2,}/g, " ")
        .replace(/^\s+/, "");
    });

    phoneInput?.addEventListener("input", function () {
      this.value = formatBrazilianPhone(this.value);
    });

    $$('[data-open-rsvp]').forEach((button) => {
      button.addEventListener("click", () => {
        setView(dialog, "form");
        if (statusNode) statusNode.textContent = "";

        if (typeof dialog.showModal === "function") {
          dialog.showModal();
        } else {
          dialog.setAttribute("open", "");
        }

        updateFormState(form);
        refreshDiaperSuggestion(form);
        nameInput?.focus();
      });
    });

    $$('[data-close-rsvp]').forEach((button) => {
      button.addEventListener("click", () => dialog.close());
    });

    form.addEventListener("input", () => {
      updateFormState(form);
      if (statusNode) statusNode.textContent = "";
    });

    form.addEventListener("change", (event) => {
      const state = updateFormState(form);
      if (statusNode) statusNode.textContent = "";

      if (
        event.target &&
        (event.target.name === "giftType" || event.target.name === "status") &&
        state?.showDiaperBox
      ) {
        refreshDiaperSuggestion(form);
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      if (!statusNode || !submitButton) return;

      const selectedGift = $('input[name="giftType"]:checked', form)?.value;
      const selectedStatus = $("#status", form)?.value;
      const diaperInput = $("[data-diaper-size-input]", form);
      const wantsDiaper =
        selectedStatus !== "declined" && selectedGift === "fralda";

      const payload = getFormPayload(form);
      const normalizedName = payload.name.replace(/\s+/g, " ").trim();
      const phoneDigits = payload.phone.replace(/\D/g, "");

      const validName =
        normalizedName.length >= 3 &&
        /^[A-Za-zÀ-ÖØ-öø-ÿ'´\- ]+$/.test(normalizedName);

      const validPhone = phoneDigits.length === 10 || phoneDigits.length === 11;

      if (payload.website) {
        setView(dialog, "success");
        fillSuccessView(dialog, payload);
        return;
      }

      if (!validName) {
        statusNode.textContent = "Informe um nome válido usando apenas letras.";
        nameInput?.focus();
        return;
      }

      if (!validPhone) {
        statusNode.textContent = "Informe um WhatsApp válido com DDD.";
        phoneInput?.focus();
        return;
      }

      if (wantsDiaper && !diaperInput?.value) {
        statusNode.textContent =
          "Aguarde alguns instantes enquanto consultamos o tamanho da fralda.";

        const suggestion = await refreshDiaperSuggestion(form);

        if (!suggestion || !diaperInput?.value) {
          statusNode.textContent =
            "Não conseguimos consultar o estoque agora. Tente novamente em alguns instantes.";
          return;
        }
      }

      const finalPayload = getFormPayload(form);
      finalPayload.name = normalizedName;
      finalPayload.phone = formatBrazilianPhone(phoneDigits);

      submitButton.disabled = true;
      statusNode.textContent = "Enviando confirmação...";

      try {
        await sendPayload(finalPayload);
        fillSuccessView(dialog, finalPayload);
        setView(dialog, "success");

        form.reset();
        const adultsInput = $("#adults", form);
        const childrenInput = $("#children", form);
        if (adultsInput) adultsInput.value = "1";
        if (childrenInput) childrenInput.value = "0";
        updateFormState(form);
        statusNode.textContent = "";
      } catch (_) {
        statusNode.textContent =
          "Não foi possível enviar agora. Tente novamente em instantes.";
      } finally {
        submitButton.disabled = false;
      }
    });

    updateFormState(form);
  }

  document.addEventListener("DOMContentLoaded", () => {
    setCountdown();
    window.setInterval(setCountdown, 1000);
    setupDialog();
    renderLocalTable();

    // Pré-carrega a sugestão enquanto a pessoa lê o convite.
    fetchDiaperSuggestion().catch(() => { });

    $$('[data-export-local]').forEach((button) => {
      button.addEventListener("click", downloadCsv);
    });

    $$('[data-clear-local]').forEach((button) => {
      const originalText = button.textContent;
      let confirming = false;
      let revertTimer = null;

      button.addEventListener("click", () => {
        if (!confirming) {
          confirming = true;
          button.textContent = "Clique de novo para confirmar";
          button.classList.add("is-confirming");
          revertTimer = window.setTimeout(() => {
            confirming = false;
            button.textContent = originalText;
            button.classList.remove("is-confirming");
          }, 4000);
          return;
        }

        window.clearTimeout(revertTimer);
        confirming = false;
        button.textContent = originalText;
        button.classList.remove("is-confirming");
        localStorage.removeItem(storageKey);
        renderLocalTable();
      });
    });
  });
})();