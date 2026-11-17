/**
 * VIP Shield - Proteção Anti-Print, Anti-Gravação e Marca d'Água Dinâmica
 */
(function () {
  // 1. Injeta o CSS de proteção e tela preta
  const style = document.createElement('style');
  style.innerHTML = `
    .vip-protected-wrap {
      position: relative;
      overflow: hidden;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
    }
    .vip-protected-wrap img,
    .vip-protected-wrap video,
    .vip-protected-wrap canvas {
      pointer-events: none;
      user-select: none;
      -webkit-user-drag: none;
    }
    .vip-protected-wrap video {
      pointer-events: auto; /* Permite dar play/pause no player */
    }
    .vip-watermark-overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .vip-watermark-text {
      color: rgba(255, 255, 255, 0.24);
      font-family: monospace;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 1px;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.65);
      transform: rotate(-22deg);
      white-space: nowrap;
      transition: transform 2.5s ease-in-out;
    }
    /* Cortina preta quando detecta tentativa de captura ou perda de foco */
    #vip-blackout-curtain {
      position: fixed;
      inset: 0;
      background: #090b10;
      color: #fff;
      z-index: 999999;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 24px;
      font-family: 'Montserrat', sans-serif;
    }
    #vip-blackout-curtain.active {
      display: flex;
    }
  `;
  document.head.appendChild(style);

  // Cria a cortina de bloqueio instantâneo
  const curtain = document.createElement('div');
  curtain.id = 'vip-blackout-curtain';
  curtain.innerHTML = `
    <div style="font-size:42px;margin-bottom:12px;">🔒</div>
    <h2 style="font-size:18px;margin-bottom:8px;">Conteúdo Protegido</h2>
    <p style="font-size:13px;color:#94a3b8;max-width:340px;">
      Capturas de tela, gravações e inspeção são bloqueadas para proteger os direitos da criadora.
    </p>
  `;
  document.body.appendChild(curtain);

  function triggerBlackout(pauseVideos = true) {
    curtain.classList.add('active');
    if (pauseVideos) {
      document.querySelectorAll('.vip-protected-wrap video').forEach((v) => {
        if (!v.paused) v.pause();
      });
    }
  }

  function releaseBlackout() {
    curtain.classList.remove('active');
  }

  // 2. Bloqueio de botão direito e arrastar
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.vip-protected-wrap')) e.preventDefault();
  });

  document.addEventListener('dragstart', (e) => {
    if (e.target.closest('.vip-protected-wrap')) e.preventDefault();
  });

  // 3. Bloqueio de atalhos de PrintScreen, Salvar e DevTools
  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    // PrintScreen
    if (e.key === 'PrintScreen') {
      triggerBlackout();
      navigator.clipboard?.writeText('Conteúdo protegido - Portal VIP').catch(() => {});
      setTimeout(releaseBlackout, 2500);
    }
    // Ctrl+S, Ctrl+U, Ctrl+P, Ctrl+Shift+I/J/C, F12
    if (
      (e.ctrlKey && (key === 's' || key === 'u' || key === 'p')) ||
      (e.ctrlKey && e.shiftKey && (key === 'i' || key === 'j' || key === 'c')) ||
      e.key === 'F12'
    ) {
      e.preventDefault();
      triggerBlackout();
      setTimeout(releaseBlackout, 2000);
    }
  });

  // 4. Detecta perda de foco (Ferramenta de Captura do Windows / Gravação no Celular)
  window.addEventListener('blur', () => triggerBlackout(false));
  window.addEventListener('focus', () => releaseBlackout());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) triggerBlackout(true);
    else releaseBlackout();
  });

  // 5. Função pública para proteger elementos e desenhar fotos em Canvas
  window.applyVipShield = function (subscriberLabel) {
    const watermarkTag = subscriberLabel || 'PORTAL VIP • PROTEGIDO';

    document.querySelectorAll('.vip-protected-wrap').forEach((wrap) => {
      if (wrap.dataset.shielded === '1') return;
      wrap.dataset.shielded = '1';

      // Aplica bloqueio de download em vídeos
      const video = wrap.querySelector('video');
      if (video) {
        video.setAttribute('controlsList', 'nodownload noplaybackrate');
        video.setAttribute('disablePictureInPicture', 'true');
        video.setAttribute('oncontextmenu', 'return false;');
      }

      // Converte imagem VIP para Canvas (impede "Salvar imagem como")
      const img = wrap.querySelector('img[data-vip-canvas]');
      if (img) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const loader = new Image();
        loader.crossOrigin = 'anonymous';
        loader.onload = function () {
          canvas.width = loader.naturalWidth;
          canvas.height = loader.naturalHeight;
          canvas.style.width = '100%';
          canvas.style.height = '100%';
          canvas.style.objectFit = 'cover';
          canvas.style.display = 'block';
          ctx.drawImage(loader, 0, 0);
          img.replaceWith(canvas);
        };
        loader.src = img.src;
      }

      // Adiciona marca d'água dinâmica
      const overlay = document.createElement('div');
      overlay.className = 'vip-watermark-overlay';
      const span = document.createElement('span');
      span.className = 'vip-watermark-text';
      span.textContent = `${watermarkTag} • ${new Date().toLocaleDateString('pt-BR')}`;
      overlay.appendChild(span);
      wrap.appendChild(overlay);

      // Movimenta suavemente a marca d'água a cada 4 segundos
      setInterval(() => {
        const x = Math.floor(Math.random() * 40) - 20;
        const y = Math.floor(Math.random() * 40) - 20;
        span.style.transform = `translate(${x}px, ${y}px) rotate(-22deg)`;
      }, 4000);
    });
  };
})();