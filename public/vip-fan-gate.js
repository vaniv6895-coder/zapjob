(function () {
  let reservedCreatorNamesSet = new Set();

  function normalizeCandidate(val) {
    return String(val || '')
      .replace(/<[^>]*>/g, '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
  }

  async function loadReservedCreatorNames() {
    try {
      const res = await fetch('/api/vip/reserved-names');
      const data = await res.json().catch(() => ({}));
      const list = Array.isArray(data.reserved) ? data.reserved : [];
      const nextSet = new Set();

      for (const item of list) {
        const cleanName = normalizeCandidate(item?.stage_name);
        const cleanSlug = normalizeCandidate(String(item?.slug || '').replace(/-/g, ' '));
        if (cleanName) nextSet.add(cleanName);
        if (cleanSlug) nextSet.add(cleanSlug);
      }

      reservedCreatorNamesSet = nextSet;
    } catch {}
  }

  async function isCreatorNameReserved(nameOrContact) {
    const clean = normalizeCandidate(nameOrContact);
    if (!clean) return false;
    if (!reservedCreatorNamesSet.size) {
      await loadReservedCreatorNames();
    }
    return reservedCreatorNamesSet.has(clean);
  }

  loadReservedCreatorNames();

  function getSavedFan() {
    try {
      const raw = localStorage.getItem('vip_fan_profile');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveFan(fan) {
    localStorage.setItem('vip_fan_profile', JSON.stringify(fan));
  }

  // Captura retorno automático do login com Google (?fan_auth=...)
  (function checkGoogleCallback() {
    const params = new URLSearchParams(window.location.search);
    const fanAuth = params.get('fan_auth');
    if (!fanAuth) return;
    try {
      const json = atob(fanAuth.replace(/-/g, '+').replace(/_/g, '/'));
      const fan = JSON.parse(json);
      if (fan && fan.fan_code) {
        saveFan(fan);
        params.delete('fan_auth');
        const cleanQuery = params.toString();
        const cleanUrl = window.location.pathname + (cleanQuery ? '?' + cleanQuery : '');
        window.history.replaceState({}, '', cleanUrl);
        window.addEventListener('DOMContentLoaded', () => {
          if (!fan.nickname) {
            window.showFanOnboardingStep(fan);
          }
        });
      }
    } catch {}
  })();

  function injectGateModal() {
    if (document.getElementById('vipFanGateModal')) return;

    const style = document.createElement('style');
    style.textContent = `
      .fan-gate-backdrop {
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(5, 5, 8, 0.88);
        backdrop-filter: blur(10px);
        display: none; align-items: center; justify-content: center;
        padding: 16px;
        font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      }
      .fan-gate-backdrop.open { display: flex; }
      .fan-gate-card {
        width: 100%; max-width: 400px;
        background: #121216;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 20px;
        padding: 22px 20px;
        color: #fafafa;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.85);
      }
      .fan-gate-card input {
        width: 100%;
        background: #09090c;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 11px;
        padding: 11px 13px;
        color: #fff;
        font-size: 13.5px;
        margin-bottom: 10px;
        outline: none;
      }
      .fan-gate-card input:focus { border-color: #e11d48; }
      .fan-gate-btn {
        width: 100%;
        padding: 12px;
        border: none;
        border-radius: 12px;
        background: linear-gradient(135deg, #e11d48, #9333ea);
        color: #fff;
        font-weight: 800;
        font-size: 13.5px;
        cursor: pointer;
      }
      .fan-gate-google {
        width: 100%;
        padding: 11px;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.16);
        background: #18181f;
        color: #fff;
        font-weight: 700;
        font-size: 13px;
        cursor: pointer;
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
      }
      .fan-id-pill-box {
        background: rgba(225, 29, 72, 0.12);
        border: 1px solid rgba(225, 29, 72, 0.45);
        border-radius: 14px;
        padding: 14px;
        text-align: center;
        margin: 12px 0 14px;
      }
    `;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.id = 'vipFanGateModal';
    wrap.className = 'fan-gate-backdrop';
    wrap.innerHTML = `
      <div class="fan-gate-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-size:11px;font-weight:800;color:#fb7185;text-transform:uppercase;letter-spacing:0.05em;">
            💎 Conta Exclusiva VIP
          </span>
          <button type="button" id="closeFanGateBtn" style="background:none;border:none;color:#a1a1aa;font-size:20px;cursor:pointer;">✕</button>
        </div>

        <!-- ETAPA 1: LOGIN / CADASTRO -->
        <div id="fanGateStepAuth">
          <h3 id="fanGateTitle" style="font-size:18px;font-weight:800;margin-bottom:6px;">Entre ou crie sua conta</h3>
          <p style="font-size:12.5px;color:#a1a1aa;line-height:1.45;margin-bottom:14px;">
            Gere seu ID exclusivo de fã para salvar suas assinaturas e conteúdos comprados.
          </p>

          <button type="button" id="btnGoogleFanGate" class="fan-gate-google">
            <strong style="color:#fb7185;">G</strong> Continuar com Google
          </button>

          <form id="fanGateForm">
            <input type="text" id="fgContact" required placeholder="Seu E-mail ou WhatsApp (com DDD)" />
            <input type="password" id="fgPass" required placeholder="Crie uma senha (mín. 4 dígitos)" />
            <button type="submit" id="fgSubmitBtn" class="fan-gate-btn">Continuar →</button>
          </form>

          <p id="fgError" style="font-size:12px;color:#fb7185;margin-top:8px;font-weight:600;"></p>

          <div style="margin-top:12px;text-align:center;font-size:12px;color:#a1a1aa;">
            <button type="button" id="fgToggleMode" style="background:none;border:none;color:#fda4af;font-weight:700;cursor:pointer;text-decoration:underline;">
              Já tenho conta — Fazer login
            </button>
          </div>
        </div>

        <!-- ETAPA 2: MOSTRA O ID EXCLUSIVO E PERGUNTA COMO QUER SER CHAMADO -->
        <div id="fanGateStepNickname" style="display:none;">
          <h3 style="font-size:18px;font-weight:800;margin-bottom:4px;">Seu ID Exclusivo foi criado!</h3>
          <p style="font-size:12px;color:#a1a1aa;">Guarde este código para identificar suas assinaturas:</p>

          <div class="fan-id-pill-box">
            <span style="font-size:10.5px;color:#fda4af;font-weight:700;display:block;">SEU ID EXCLUSIVO VIP</span>
            <strong id="fgCreatedCode" style="font-size:22px;font-weight:900;color:#fff;letter-spacing:0.06em;">FAN-000000</strong>
          </div>

          <form id="fanNicknameForm">
            <label style="display:block;font-size:12px;font-weight:700;color:#e4e4e7;margin-bottom:6px;">
              Como você quer ser chamado?
            </label>
            <input type="text" id="fgNicknameInput" required placeholder="Ex: João, Rei VIP, Marcos..." />
            <button type="submit" id="fgSaveNickBtn" class="fan-gate-btn">Salvar e Continuar →</button>
          </form>
          <p id="fgNickError" style="font-size:12px;color:#fb7185;margin-top:8px;font-weight:600;"></p>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
  }

  window.showFanOnboardingStep = function (fan, onDone) {
    injectGateModal();
    const modal = document.getElementById('vipFanGateModal');
    document.getElementById('fanGateStepAuth').style.display = 'none';
    document.getElementById('fanGateStepNickname').style.display = 'block';
    document.getElementById('fgCreatedCode').innerText = fan.fan_code || 'FAN-VIP';
    const nickInput = document.getElementById('fgNicknameInput');
    const nickErr = document.getElementById('fgNickError');
    if (nickErr) nickErr.innerText = '';
    nickInput.value = fan.nickname || fan.full_name || '';
    modal.classList.add('open');

    document.getElementById('closeFanGateBtn').onclick = () => modal.classList.remove('open');

    document.getElementById('fanNicknameForm').onsubmit = async (e) => {
      e.preventDefault();
      if (nickErr) nickErr.innerText = '';
      const nick = nickInput.value.replace(/<[^>]*>/g, '').trim().slice(0, 60);
      if (!nick || nick.length < 2) {
        if (nickErr) nickErr.innerText = 'Digite um apelido com pelo menos 2 caracteres.';
        return;
      }

      if (await isCreatorNameReserved(nick)) {
        if (nickErr) nickErr.innerText = 'Este nome pertence a uma modelo e não pode ser usado por assinantes.';
        return;
      }

      const btn = document.getElementById('fgSaveNickBtn');
      btn.disabled = true;

      try {
        const res = await fetch('/api/vip/fan-nickname', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fanCode: fan.fan_code, nickname: nick }),
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok || data.ok === false) {
          if (nickErr) nickErr.innerText = data.error || 'Apelido não permitido.';
          btn.disabled = false;
          return;
        }

        const updatedFan = data.fan ? data.fan : { ...fan, nickname: nick, full_name: nick };
        saveFan(updatedFan);
        modal.classList.remove('open');
        if (typeof onDone === 'function') onDone(updatedFan);
      } catch {
        if (nickErr) nickErr.innerText = 'Erro de conexão ao salvar apelido. Tente novamente.';
      } finally {
        btn.disabled = false;
      }
    };
  };

  window.ensureFanAuthenticated = async function (onAuthenticated) {
    const existing = getSavedFan();
    if (existing && existing.fan_code && existing.nickname) {
      if (typeof onAuthenticated === 'function') onAuthenticated(existing);
      return existing;
    }
    if (existing && existing.fan_code && !existing.nickname) {
      window.showFanOnboardingStep(existing, onAuthenticated);
      return existing;
    }

    injectGateModal();
    const modal = document.getElementById('vipFanGateModal');
    document.getElementById('fanGateStepAuth').style.display = 'block';
    document.getElementById('fanGateStepNickname').style.display = 'none';

    const form = document.getElementById('fanGateForm');
    const contactInp = document.getElementById('fgContact');
    const passInp = document.getElementById('fgPass');
    const titleEl = document.getElementById('fanGateTitle');
    const submitBtn = document.getElementById('fgSubmitBtn');
    const toggleBtn = document.getElementById('fgToggleMode');
    const errEl = document.getElementById('fgError');
    let isLogin = false;

    modal.classList.add('open');
    errEl.innerText = '';

    document.getElementById('closeFanGateBtn').onclick = () => modal.classList.remove('open');

    document.getElementById('btnGoogleFanGate').onclick = () => {
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/api/auth/google/fan?returnTo=${returnTo}`;
    };

    toggleBtn.onclick = () => {
      isLogin = !isLogin;
      titleEl.innerText = isLogin ? 'Entrar na sua conta VIP' : 'Entre ou crie sua conta';
      submitBtn.innerText = isLogin ? 'Entrar →' : 'Continuar →';
      toggleBtn.innerText = isLogin ? 'Não tenho conta — Criar agora' : 'Já tenho conta — Fazer login';
      errEl.innerText = '';
    };

    form.onsubmit = async (e) => {
      e.preventDefault();
      errEl.innerText = '';

      const contactVal = contactInp.value.replace(/<[^>]*>/g, '').trim();
      const derivedName = contactVal.split('@')[0] || 'Assinante VIP';

      if (!isLogin && (await isCreatorNameReserved(contactVal) || await isCreatorNameReserved(derivedName))) {
        errEl.innerText = 'Este nome ou contato pertence a uma modelo e não pode ser usado no cadastro de fã.';
        return;
      }

      submitBtn.disabled = true;

      let deviceHash = '';
      if (typeof window.getDeviceHash === 'function') {
        deviceHash = await window.getDeviceHash();
      }
      if (!deviceHash) {
        deviceHash = localStorage.getItem('vip_device_hash') || '';
      }

      const endpoint = isLogin ? '/api/vip/fan-login' : '/api/vip/fan-register';
      const payload = {
        fullName: derivedName,
        contact: contactVal,
        password: passInp.value.trim(),
        deviceHash,
      };

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          errEl.innerText = data.error || 'Verifique os dados informados.';
          submitBtn.disabled = false;
          return;
        }

        saveFan(data.fan);
        if (isLogin && data.fan.nickname) {
          modal.classList.remove('open');
          if (typeof onAuthenticated === 'function') onAuthenticated(data.fan);
        } else {
          window.showFanOnboardingStep(data.fan, onAuthenticated);
        }
      } catch {
        errEl.innerText = 'Erro de conexão. Tente novamente.';
      } finally {
        submitBtn.disabled = false;
      }
    };
  };
})();