(function () {
  function getSavedFan() {
    try {
      const raw = localStorage.getItem('vip_fan_profile');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function injectGateModal() {
    if (document.getElementById('vipFanGateModal')) return;

    const style = document.createElement('style');
    style.textContent = `
      .fan-gate-backdrop {
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(5, 5, 8, 0.86);
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
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.8);
      }
      .fan-gate-card input {
        width: 100%;
        background: #09090c;
        border: 1px solid rgba(255, 255, 255, 0.1);
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
        border: 1px solid rgba(255,255,255,0.14);
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
    `;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.id = 'vipFanGateModal';
    wrap.className = 'fan-gate-backdrop';
    wrap.innerHTML = `
      <div class="fan-gate-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-size:11px;font-weight:800;color:#fb7185;text-transform:uppercase;letter-spacing:0.05em;">
            💎 Acesso ao Clube VIP
          </span>
          <button type="button" id="closeFanGateBtn" style="background:none;border:none;color:#a1a1aa;font-size:20px;cursor:pointer;">✕</button>
        </div>
        <h3 id="fanGateTitle" style="font-size:18px;font-weight:800;margin-bottom:6px;">Crie sua conta para liberar</h3>
        <p style="font-size:12.5px;color:#a1a1aa;line-height:1.45;margin-bottom:14px;">
          Suas assinaturas e conteúdos comprados ficam salvos no seu <strong>Painel do Cliente</strong> para acessar quando quiser.
        </p>

        <button type="button" id="btnGoogleFanGate" class="fan-gate-google">
          <span>G</span> Continuar com Google
        </button>

        <form id="fanGateForm">
          <input type="text" id="fgName" placeholder="Seu nome ou apelido" />
          <input type="text" id="fgContact" required placeholder="Seu E-mail ou WhatsApp (com DDD)" />
          <input type="password" id="fgPass" required placeholder="Crie uma senha (mín. 4 dígitos)" />
          <button type="submit" id="fgSubmitBtn" class="fan-gate-btn">Criar Conta e Continuar para Pagamento</button>
        </form>

        <p id="fgError" style="font-size:12px;color:#fb7185;margin-top:8px;font-weight:600;"></p>

        <div style="margin-top:12px;text-align:center;font-size:12px;color:#a1a1aa;">
          <button type="button" id="fgToggleMode" style="background:none;border:none;color:#fda4af;font-weight:700;cursor:pointer;text-decoration:underline;">
            Já tenho conta — Fazer login
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
  }

  window.ensureFanAuthenticated = async function (onAuthenticated) {
    const existing = getSavedFan();
    if (existing && existing.fan_code) {
      if (typeof onAuthenticated === 'function') onAuthenticated(existing);
      return existing;
    }

    injectGateModal();
    const modal = document.getElementById('vipFanGateModal');
    const form = document.getElementById('fanGateForm');
    const nameInp = document.getElementById('fgName');
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
      nameInp.style.display = isLogin ? 'none' : 'block';
      titleEl.innerText = isLogin ? 'Entrar na sua conta VIP' : 'Crie sua conta para liberar';
      submitBtn.innerText = isLogin ? 'Entrar e Continuar para Pagamento' : 'Criar Conta e Continuar para Pagamento';
      toggleBtn.innerText = isLogin ? 'Não tenho conta — Criar agora' : 'Já tenho conta — Fazer login';
      errEl.innerText = '';
    };

    form.onsubmit = async (e) => {
      e.preventDefault();
      errEl.innerText = '';
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
        fullName: nameInp.value.trim(),
        contact: contactInp.value.trim(),
        password: passInp.value.trim(),
        deviceHash,
      };

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          errEl.innerText = data.error || 'Verifique os dados informados.';
          submitBtn.disabled = false;
          return;
        }

        localStorage.setItem('vip_fan_profile', JSON.stringify(data.fan));
        modal.classList.remove('open');
        if (typeof onAuthenticated === 'function') onAuthenticated(data.fan);
      } catch {
        errEl.innerText = 'Erro de conexão. Tente novamente.';
      } finally {
        submitBtn.disabled = false;
      }
    };
  };
})();