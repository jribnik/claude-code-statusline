// Classic script, loaded after src/shared/config.js and src/shared/render.js
// (see manifest.json / options.html). Owns the options UI: loads the stored
// config, renders the form, autosaves on change (debounced for freeform
// text/number/color inputs, immediate for checkboxes/selects/reorder), and
// keeps a live preview in sync using the same CCSL_RENDER code the real bar
// uses, so "what you see here" always matches claude.ai/code.

(() => {
  const SAMPLE_STATE = {
    branch: 'main',
    fiveHourPct: 78,
    fiveHourResetsAt: new Date(Date.now() + (2 * 3600 + 10 * 60) * 1000).toISOString(),
    sevenDayPct: 41,
    sevenDayResetsAt: new Date(Date.now() + (3 * 86400 + 4 * 3600) * 1000).toISOString(),
    drift: { packVersion: 2, items: [{ endpoint: 'sample', key: 'field' }] },
  };

  const FIELD_LABELS = { branch: 'Branch', fiveHour: '5h limit', sevenDay: '7d limit' };
  const COLOR_KEYS = ['text', 'dim', 'ok', 'warn', 'crit'];

  let config = CCSL_CONFIG.DEFAULTS;
  let saveTimer = null;
  let savedHintTimer = null;

  function cap(s) {
    return s[0].toUpperCase() + s.slice(1);
  }

  const els = {
    savedHint: document.getElementById('savedHint'),
    previewBar: document.getElementById('previewBar'),
    segments: document.getElementById('segments'),
    separator: document.getElementById('separator'),
    fontSize: document.getElementById('fontSize'),
    barWidth: document.getElementById('barWidth'),
    barFilled: document.getElementById('barFilled'),
    barEmpty: document.getElementById('barEmpty'),
    driftIndicator: document.getElementById('driftIndicator'),
    thresholdWarn: document.getElementById('thresholdWarn'),
    thresholdCrit: document.getElementById('thresholdCrit'),
    resetBtn: document.getElementById('resetBtn'),
  };
  for (const key of COLOR_KEYS) {
    els[`color_${key}`] = document.getElementById(`color${cap(key)}`);
    els[`color_${key}_hex`] = document.getElementById(`color${cap(key)}Hex`);
  }

  function currentNormalized() {
    return CCSL_CONFIG.normalize(config);
  }

  function renderPreview() {
    const normalized = currentNormalized();
    els.previewBar.replaceChildren(...CCSL_RENDER.buildNodes(SAMPLE_STATE, normalized, Date.now()));
    els.previewBar.style.fontSize = `${normalized.fontSize}px`;
  }

  function showSavedHint() {
    els.savedHint.hidden = false;
    els.savedHint.classList.add('visible');
    clearTimeout(savedHintTimer);
    savedHintTimer = setTimeout(() => els.savedHint.classList.remove('visible'), 1200);
  }

  function saveNow() {
    chrome.storage.sync.set({ [CCSL_CONFIG.STORAGE_KEY]: currentNormalized() }, showSavedHint);
  }

  function onConfigChanged({ immediate = false } = {}) {
    renderPreview();
    clearTimeout(saveTimer);
    if (immediate) {
      saveNow();
    } else {
      saveTimer = setTimeout(saveNow, 300);
    }
  }

  function labeledControl(text, control) {
    const label = document.createElement('label');
    label.append(document.createTextNode(text), control);
    return label;
  }

  function selectControl(options, value, onChange) {
    const select = document.createElement('select');
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      select.append(o);
    }
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  function checkboxControl(checked, onChange) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    return input;
  }

  function textControl(value, onChange) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.addEventListener('input', () => onChange(input.value));
    return input;
  }

  function buildSubControls(field) {
    const controls = [];

    if (field.id === 'branch') {
      controls.push(
        labeledControl(
          'Bold',
          checkboxControl(field.bold, (v) => {
            field.bold = v;
            onConfigChanged({ immediate: true });
          })
        )
      );
      return controls;
    }

    controls.push(
      labeledControl(
        'Label',
        textControl(field.label, (v) => {
          field.label = v;
          onConfigChanged();
        })
      )
    );

    // fiveHour / sevenDay
    controls.push(
      labeledControl(
        'Style',
        selectControl(['bar', 'text'], field.style, (v) => {
          field.style = v;
          onConfigChanged({ immediate: true });
        })
      )
    );
    controls.push(
      labeledControl(
        'Resets',
        checkboxControl(field.showResets, (v) => {
          field.showResets = v;
          onConfigChanged({ immediate: true });
        })
      )
    );
    controls.push(
      labeledControl(
        'Format',
        selectControl(['relative', 'clock'], field.resetsFormat, (v) => {
          field.resetsFormat = v;
          onConfigChanged({ immediate: true });
        })
      )
    );
    return controls;
  }

  function moveField(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= config.fields.length) return;
    const [item] = config.fields.splice(index, 1);
    config.fields.splice(target, 0, item);
    renderSegments();
    onConfigChanged({ immediate: true });
  }

  function renderSegments() {
    els.segments.replaceChildren();
    config.fields.forEach((field, index) => {
      const row = document.createElement('div');
      row.className = 'segment-row';
      row.dataset.fieldId = field.id;

      const reorder = document.createElement('div');
      reorder.className = 'reorder';
      const up = document.createElement('button');
      up.type = 'button';
      up.textContent = '▲';
      up.disabled = index === 0;
      up.addEventListener('click', () => moveField(index, -1));
      const down = document.createElement('button');
      down.type = 'button';
      down.textContent = '▼';
      down.disabled = index === config.fields.length - 1;
      down.addEventListener('click', () => moveField(index, 1));
      reorder.append(up, down);

      const enabled = checkboxControl(field.enabled, (v) => {
        field.enabled = v;
        onConfigChanged({ immediate: true });
      });

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = FIELD_LABELS[field.id] || field.id;

      const sub = document.createElement('div');
      sub.className = 'sub-controls';
      sub.append(...buildSubControls(field));

      row.append(reorder, enabled, name, sub);
      els.segments.append(row);
    });
  }

  function wireStaticControls() {
    els.separator.addEventListener('input', () => {
      config.separator = els.separator.value;
      onConfigChanged();
    });
    els.fontSize.addEventListener('input', () => {
      config.fontSize = Number(els.fontSize.value);
      onConfigChanged();
    });
    els.barWidth.addEventListener('input', () => {
      config.bar.width = Number(els.barWidth.value);
      onConfigChanged();
    });
    els.barFilled.addEventListener('input', () => {
      config.bar.filled = els.barFilled.value;
      onConfigChanged();
    });
    els.barEmpty.addEventListener('input', () => {
      config.bar.empty = els.barEmpty.value;
      onConfigChanged();
    });
    els.driftIndicator.addEventListener('change', () => {
      config.driftIndicator = els.driftIndicator.checked;
      onConfigChanged({ immediate: true });
    });
    els.thresholdWarn.addEventListener('input', () => {
      config.thresholds.warn = Number(els.thresholdWarn.value);
      onConfigChanged();
    });
    els.thresholdCrit.addEventListener('input', () => {
      config.thresholds.crit = Number(els.thresholdCrit.value);
      onConfigChanged();
    });

    for (const key of COLOR_KEYS) {
      const colorInput = els[`color_${key}`];
      const hexInput = els[`color_${key}_hex`];
      colorInput.addEventListener('input', () => {
        config.colors[key] = colorInput.value;
        hexInput.value = colorInput.value;
        onConfigChanged();
      });
      hexInput.addEventListener('change', () => {
        config.colors[key] = hexInput.value;
        onConfigChanged({ immediate: true });
        const normalizedColor = currentNormalized().colors[key];
        colorInput.value = normalizedColor;
        hexInput.value = normalizedColor;
      });
    }

    els.resetBtn.addEventListener('click', () => {
      if (!confirm('Reset all status line settings to defaults?')) return;
      config = JSON.parse(JSON.stringify(CCSL_CONFIG.DEFAULTS));
      chrome.storage.sync.set({ [CCSL_CONFIG.STORAGE_KEY]: config }, () => {
        populateForm();
        showSavedHint();
      });
    });
  }

  function populateForm() {
    els.separator.value = config.separator;
    els.fontSize.value = config.fontSize;
    els.barWidth.value = config.bar.width;
    els.barFilled.value = config.bar.filled;
    els.barEmpty.value = config.bar.empty;
    els.driftIndicator.checked = config.driftIndicator;
    els.thresholdWarn.value = config.thresholds.warn;
    els.thresholdCrit.value = config.thresholds.crit;
    for (const key of COLOR_KEYS) {
      els[`color_${key}`].value = config.colors[key];
      els[`color_${key}_hex`].value = config.colors[key];
    }
    renderSegments();
    renderPreview();
  }

  wireStaticControls();
  chrome.storage.sync.get({ [CCSL_CONFIG.STORAGE_KEY]: null }, (result) => {
    config = CCSL_CONFIG.normalize(result[CCSL_CONFIG.STORAGE_KEY]);
    populateForm();
  });
})();
