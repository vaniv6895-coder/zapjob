/**
 * Device Fingerprint + Modal de Visualização Única (PPV)
 */
(function () {
  // 1. Gera hash SHA-256 único do dispositivo
  async function computeDeviceHash() {
    let localSeed = localStorage.getItem('pv_device_seed');
    if (!localSeed) {
      localSeed = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now();
      localStorage.setItem('pv_device_seed', localSeed);
    }

    // Coleta assinatura de hardware do celular/navegador
    let gpuInfo = '';
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) gpuInfo = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      }
    } catch (_) {}

    const rawFingerprint = [
      localSeed,
      navigator.platform || '',
      navigator.hardwareConcurrency || '',
      screen.width + 'x' + screen.height,
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      gpuInfo
    ].join('|');

    const msgBuffer = new TextEncoder().encode(rawFingerprint);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    // Grava também em cookie para o backend ler automaticamente se necessário
    document.cookie = `pv_dev=${hex}; path=/; max-age=31536000; SameSite=Lax`;
    return hex;
  }

  window.getDeviceHash = computeDeviceHash;

  // 2. Injeta estilos do Modal de Visualização Única
  const style = document.createElement('style');
  style.innerHTML = `
    #pv-once-modal {
      position: fixed;
      inset: 0;
      background: #07090e;
      z-index: 99998;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 16px;
      color: #fff;
      font-family: 'Montserrat', sans-serif;
    }
    #pv-once-modal.open { display: flex; }
    .pv-once-topbar {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      padding: 14px 18px;
      background: linear-gradient(180deg, rgba(0,0,0,0.85), transparent);
      z-index: 30;
    }
    .pv-timer-track {
      width: 100%;
      height: 4px;
      background: rgba(255,255,255,0.2);
      border-radius: 99px;
      overflow: hidden;
      margin-bottom: 10px;
    }
    .pv-timer-fill {
      width: 100%;
      height: 100%;
      background: #e25352;
      transition: width 1s linear;
    }
    .pv-once-header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      font-weight: 700;
    }
    .pv-once-stage {
      width: 100%;
      max-width: 460px;
      max-height: 82dvh;
      border-radius: 12px;
      overflow: hidden;
    }
  `;
  document.head.appendChild(style);

  const modal = document.createElement('div');
  modal.id = 'pv-once-modal';
  modal.innerHTML = `
    <div class="pv-once-topbar">
      <div class="pv-timer-track"><div id="pv-timer-fill" class="pv-timer-fill"></div></div>
      <div class="pv-once-header-row">
        <span>🔥 VISUALIZAÇÃO ÚNICA • <span id="pv-seconds-left">30</span>s</span>
        <button onclick="closeOnceModal()" style="background:rgba(255,255,255,0.2);border:none;color:#fff;padding:5px 12px;border-radius:99px;font-weight:700;cursor:pointer;">Fechar ✕</button>
      </div>
    </div>
    <div id="pv-once-stage" class="pv-once-stage vip-protected-wrap"></div>
  `;
  document.body.appendChild(modal);

  let countdownTimer = null;

  window.closeOnceModal = function () {
    clearInterval(countdownTimer);
    const stage = document.getElementById('pv-once-stage');
    stage.innerHTML = ''; // Destrói o canvas/vídeo da memória
    delete stage.dataset.shielded;
    document.getElementById('pv-once-modal').classList.remove('open');
  };

  // 3. Solicita ao backend a abertura única vinculada a este celular
  window.openSingleViewPost = async function (postId, unlockId) {
    const deviceHash = await computeDeviceHash();

    const res = await fetch('/api/vip/consume-once', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId, unlockId, deviceHash })
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      alert(data.error || 'Este conteúdo já foi visualizado ou pertence a outro aparelho.');
      return;
    }

    // Marca o card na tela como expirado imediatamente
    const cardBtn = document.getElementById(`ppv-btn-${postId}`);
    if (cardBtn) {
      cardBtn.innerText = '👁️ Visualização única concluída';
      cardBtn.disabled = true;
      cardBtn.style.background = '#455a64';
    }

    const stage = document.getElementById('pv-once-stage');
    const fill = document.getElementById('pv-timer-fill');
    const secLabel = document.getElementById('pv-seconds-left');

    if (data.mediaType === 'video') {
      stage.innerHTML = `<video src="${data.mediaUrl}" autoplay playsinline controls style="width:100%;max-height:80dvh;"></video>`;
      const vid = stage.querySelector('video');
      vid.onended = () => closeOnceModal();
    } else {
      stage.innerHTML = `<img src="${data.mediaUrl}" data-vip-canvas="1" style="width:100%;display:block;" />`;
    }

    // Aplica o VIP Shield com o ID do celular carimbado na marca d'água
    if (typeof window.applyVipShield === 'function') {
      window.applyVipShield(`${data.buyerLabel} • DEV:${deviceHash.slice(0, 8).toUpperCase()}`);
    }

    document.getElementById('pv-once-modal').classList.add('open');

    // Contagem regressiva de 30 segundos (ou 60s para vídeo)
    const totalSeconds = data.mediaType === 'video' ? 60 : 30;
    let remaining = totalSeconds;
    fill.style.width = '100%';
    secLabel.innerText = String(remaining);

    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      remaining -= 1;
      secLabel.innerText = String(Math.max(0, remaining));
      fill.style.width = `${(remaining / totalSeconds) * 100}%`;
      if (remaining <= 0) {
        closeOnceModal();
      }
    }, 1000);
  };
})();