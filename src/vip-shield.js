/**
 * VIP Shield - Proteção Anti-Print, Anti-Gravação, Anti-Download e Marca d'Água Dinâmica
 */
(function () {
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
      user-select: none;
      -webkit-user-select: none;
      -webkit-user-drag: none;
      -webkit-touch-callout: none;
    }
    .vip-protected-wrap img,
    .vip-protected-wrap canvas {
      pointer-events: none;
    }
    .vip-protected-wrap video {
      pointer-events: auto;
    }
    .vip-watermark-overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 20;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-around;
      padding: 12px;
      overflow: hidden;
    }
    .vip-watermark-text {
      color: rgba(255, 255, 255, 0.34);
      font-family: monospace;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 1px;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.75);
      transform: rotate(-22deg);
      white-space: nowrap;
      transition: transform 2.5s ease-in-out;
    }
    /* Cortina preta quando detecta tentativa de captura ou perda de foco */
    #vip-blackout-curtain {
      position: fixed;
      inset: 0;
      background: #000000;
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

  const curtain = document.createElement('div');
  curtain.id = 'vip-blackout-curtain';
  curtain.innerHTML = `
    <div style="font-size:42px;margin-bottom:12px;">🔒</div>
    <h2 style="font-size:18px;margin-bottom:8px;">Conteúdo Protegido</h2>
    <p style="font-size:13px;color:#94a3b8;max-width:340px;">
      Capturas de tela, gravações, downloads e inspeção são bloqueados para proteger os direitos da criadora.
    </p>
  `;
  document.body.appendChild(curtain);

  let releaseTimer = null;

  function triggerBlackout(pauseVideos = true, holdMs = 1500) {
    curtain.classList.add('active');
    if (pauseVideos) {
      document.querySelectorAll('.vip-protected-wrap video').forEach((v) => {
        if (!v.paused) v.pause();
      });
    }
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      if (!document.hidden) {
        curtain.classList.remove('active');
      }
    }, holdMs);
  }

  function releaseBlackout() {
    clearTimeout(releaseTimer);
    if (!document.hidden) {
      curtain.classList.remove('active');
    }
  }

  function hardenVideoElement(video) {
    if (!video || video.dataset.vipHardened === '1') return;
    video.dataset.vipHardened = '1';
    video.setAttribute('controlsList', 'nodownload noplaybackrate');
    video.setAttribute('disablePictureInPicture', 'true');
    video.disablePictureInPicture = true;
    video.setAttribute('oncontextmenu', 'return false;');
    video.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    });
  }

  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.vip-protected-wrap')) {
      e.preventDefault();
    }
  });

  document.addEventListener('dragstart', (e) => {
    if (e.target.closest('.vip-protected-wrap')) {
      e.preventDefault();
    }
  });

  document.addEventListener('keydown', (e) => {
    const key = (e.key || '').toLowerCase();
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === 'PrintScreen') {
      triggerBlackout(true, 2500);
      navigator.clipboard?.writeText('Conteúdo protegido - Portal VIP').catch(() => {});
      return;
    }

    if (
      (mod && (key === 's' || key === 'u' || key === 'p')) ||
      (mod && e.shiftKey && (key === 'i' || key === 'j' || key === 'c')) ||
      e.key === 'F12'
    ) {
      e.preventDefault();
      triggerBlackout(true, 2000);
    }
  });

  window.addEventListener('blur', () => triggerBlackout(true, 1500));
  window.addEventListener('focus', () => releaseBlackout());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) triggerBlackout(true, 4000);
    else releaseBlackout();
  });

  window.applyVipShield = function (subscriberLabel) {
    const watermarkTag = subscriberLabel || 'PORTAL VIP • PROTEGIDO';
    const fullWatermark = `${watermarkTag} • ${new Date().toLocaleDateString('pt-BR')}`;

    document.querySelectorAll('.vip-protected-wrap').forEach((wrap) => {
      const video = wrap.querySelector('video');
      if (video) {
        hardenVideoElement(video);
      }

      if (wrap.dataset.shielded === '1') return;
      wrap.dataset.shielded = '1';

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

      const overlay = document.createElement('div');
      overlay.className = 'vip-watermark-overlay';

      const spans = [0, 1, 2].map(() => {
        const span = document.createElement('span');
        span.className = 'vip-watermark-text';
        span.textContent = fullWatermark;
        overlay.appendChild(span);
        return span;
      });

      wrap.appendChild(overlay);

      setInterval(() => {
        spans.forEach((span, idx) => {
          const x = Math.floor(Math.random() * 36) - 18;
          const y = Math.floor(Math.random() * 24) - 12;
          const angle = idx % 2 === 0 ? -22 : -18;
          span.style.transform = `translate(${x}px, ${y}px) rotate(${angle}deg)`;
        });
      }, 3500);
    });
  };
})();