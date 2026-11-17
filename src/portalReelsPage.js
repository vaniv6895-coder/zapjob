import { pool } from './db.js';

export function registerPortalReelsRoute(app) {
  app.get('/reels', async (req, reply) => {
    const startSlug = req.query.modelo ? String(req.query.modelo) : null;

    // Busca vídeos publicados pelas modelos ativas no banco
    const { rows } = await pool.query(`
      SELECT 
        m.id AS media_id,
        m.public_url AS video_url,
        c.id AS creator_id,
        c.stage_name,
        c.slug,
        c.city,
        c.state,
        c.avatar_url,
        c.bio,
        c.tier
      FROM creator_media m
      JOIN creators c ON c.id = m.creator_id
      WHERE m.media_type IN ('video', 'verification')
      ORDER BY m.id DESC
      LIMIT 40
    `);

    // Vídeos verticais de demonstração caso o banco ainda esteja vazio (perfis fictícios)
    let reelsList =
      rows.length > 0
        ? rows
        : [
            {
              media_id: 1,
              video_url: 'https://assets.mixkit.co/videos/preview/mixkit-girl-in-neon-light-1282-large.mp4',
              stage_name: 'Isabela Ferraz',
              slug: 'isabela-ferraz',
              city: 'Várzea Grande',
              state: 'MT',
              avatar_url: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=300&q=80',
              bio: 'Atendimento VIP com total discrição em Várzea Grande e Cuiabá 🔥',
              tier: 'diamond'
            },
            {
              media_id: 2,
              video_url: 'https://assets.mixkit.co/videos/preview/mixkit-woman-posing-for-camera-in-studio-34420-large.mp4',
              stage_name: 'Valentina Luxo',
              slug: 'valentina-luxo',
              city: 'Cuiabá',
              state: 'MT',
              avatar_url: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=300&q=80',
              bio: 'Ensaios exclusivos e atendimento personalizado 💎',
              tier: 'diamond'
            },
            {
              media_id: 3,
              video_url: 'https://assets.mixkit.co/videos/preview/mixkit-young-woman-smiling-and-looking-at-camera-34416-large.mp4',
              stage_name: 'Camila Moraes',
              slug: 'camila-moraes',
              city: 'Cuiabá',
              state: 'MT',
              avatar_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300&q=80',
              bio: 'Confira meus vídeos exclusivos sem censura na área VIP ✨',
              tier: 'vip'
            },
            {
              media_id: 4,
              video_url: 'https://assets.mixkit.co/videos/preview/mixkit-portrait-of-a-fashion-woman-with-silver-makeup-39875-large.mp4',
              stage_name: 'Larissa Ribeiro',
              slug: 'larissa-ribeiro',
              city: 'São Paulo',
              state: 'SP',
              avatar_url: 'https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=300&q=80',
              bio: 'Disponível agora para chamada e conteúdo exclusivo 💕',
              tier: 'online'
            }
          ];

    // Se clicou no story de uma modelo específica (?modelo=slug), coloca ela em primeiro
    if (startSlug) {
      const idx = reelsList.findIndex((r) => r.slug === startSlug);
      if (idx > 0) {
        const [picked] = reelsList.splice(idx, 1);
        reelsList.unshift(picked);
      }
    }

    const slidesHtml = reelsList
      .map(
        (r, index) => `
      <section class="reel-slide" data-index="${index}">
        <video
          class="reel-video"
          src="${r.video_url}"
          playsinline
          loop
          muted
          preload="metadata"
          onclick="togglePlayPause(this)"
        ></video>

        <div class="reel-gradient-top"></div>
        <div class="reel-gradient-bottom"></div>

        <!-- Barra Lateral Direita Estilo TikTok -->
        <div class="reel-actions">
          <a href="/acompanhante/${r.slug}" class="action-avatar">
            <img src="${r.avatar_url || 'https://placehold.co/100x100'}" alt="${r.stage_name}" />
            <span class="plus-badge">+</span>
          </a>

          <button class="action-btn" onclick="toggleLike(this)">
            <span class="icon">❤️</span>
            <span class="label">${120 + index * 37}</span>
          </button>

          <a href="/vip/${r.slug}" class="action-btn vip-glow">
            <span class="icon">🔥</span>
            <span class="label">VIP</span>
          </a>

          <a href="/r/wa/${r.slug}" target="_blank" class="action-btn wa-glow">
            <span class="icon">💬</span>
            <span class="label">Whats</span>
          </a>

          <button class="action-btn" onclick="shareReel('${r.slug}', '${r.stage_name}')">
            <span class="icon">↪️</span>
            <span class="label">Enviar</span>
          </button>
        </div>

        <!-- Informações Inferiores da Modelo -->
        <div class="reel-info">
          <div class="reel-author-row">
            <a href="/acompanhante/${r.slug}" class="author-name">
              @${r.slug}
              <span class="verified-dot">✓</span>
            </a>
            <span class="city-pill">📍 ${r.city} - ${r.state}</span>
          </div>
          <p class="reel-caption">${r.bio || 'Conteúdo exclusivo e atendimento VIP.'}</p>
          <div class="reel-cta-row">
            <a href="/acompanhante/${r.slug}" class="btn-reel-profile">Ver Perfil</a>
            <a href="/vip/${r.slug}" class="btn-reel-vip">🔒 Conteúdo Exclusivo (1x)</a>
          </div>
        </div>
      </section>`
      )
      .join('');

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>VIP Reels - Portal VIP</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      background: #000;
      color: #fff;
      font-family: 'Montserrat', sans-serif;
      overflow: hidden;
    }

    /* Topo Flutuante */
    .reels-topbar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 50;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 16px;
      max-width: 520px;
      margin: 0 auto;
    }
    .top-pill {
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(8px);
      color: #fff;
      text-decoration: none;
      font-size: 13px;
      font-weight: 700;
      padding: 8px 14px;
      border-radius: 99px;
      border: 1px solid rgba(255,255,255,0.15);
      cursor: pointer;
    }

    /* Container Scroll Snap Estilo TikTok */
    .reels-feed {
      height: 100dvh;
      width: 100%;
      max-width: 520px;
      margin: 0 auto;
      overflow-y: scroll;
      scroll-snap-type: y mandatory;
      scrollbar-width: none;
      background: #090b10;
    }
    .reels-feed::-webkit-scrollbar { display: none; }

    .reel-slide {
      position: relative;
      height: 100dvh;
      width: 100%;
      scroll-snap-align: start;
      scroll-snap-stop: always;
      overflow: hidden;
      background: #000;
    }

    .reel-video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .reel-gradient-top {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 110px;
      background: linear-gradient(180deg, rgba(0,0,0,0.65), transparent);
      pointer-events: none;
    }
    .reel-gradient-bottom {
      position: absolute;
      bottom: 0; left: 0; right: 0;
      height: 260px;
      background: linear-gradient(0deg, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.4) 60%, transparent 100%);
      pointer-events: none;
    }

    /* Ações Laterais Direita */
    .reel-actions {
      position: absolute;
      right: 12px;
      bottom: 115px;
      z-index: 20;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
    }
    .action-avatar {
      position: relative;
      width: 48px;
      height: 48px;
      display: block;
    }
    .action-avatar img {
      width: 100%;
      height: 100%;
      border-radius: 50%;
      object-fit: cover;
      border: 2px solid #fff;
    }
    .plus-badge {
      position: absolute;
      bottom: -6px;
      left: 50%;
      transform: translateX(-50%);
      background: #e25352;
      color: #fff;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      font-size: 13px;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .action-btn {
      background: transparent;
      border: none;
      color: #fff;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      text-decoration: none;
      cursor: pointer;
    }
    .action-btn .icon {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.14);
      backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      transition: transform 0.15s;
    }
    .action-btn:active .icon { transform: scale(0.9); }
    .action-btn.liked .icon { background: rgba(226, 83, 82, 0.85); }
    .action-btn.vip-glow .icon { background: linear-gradient(135deg, #e25352, #b73347); }
    .action-btn.wa-glow .icon { background: #25d366; }
    .action-btn .label {
      font-size: 11px;
      font-weight: 700;
      text-shadow: 0 1px 3px rgba(0,0,0,0.8);
    }

    /* Info Inferior Esquerda */
    .reel-info {
      position: absolute;
      left: 14px;
      right: 76px;
      bottom: 22px;
      z-index: 20;
    }
    .reel-author-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 6px;
    }
    .author-name {
      color: #fff;
      text-decoration: none;
      font-size: 15px;
      font-weight: 800;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .verified-dot {
      background: #1284ed;
      color: #fff;
      font-size: 10px;
      width: 15px;
      height: 15px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .city-pill {
      font-size: 11px;
      background: rgba(255,255,255,0.16);
      padding: 3px 8px;
      border-radius: 99px;
      font-weight: 600;
    }
    .reel-caption {
      font-size: 13px;
      color: #e2e8f0;
      line-height: 1.4;
      margin-bottom: 12px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .reel-cta-row {
      display: flex;
      gap: 8px;
    }
    .btn-reel-profile {
      background: rgba(255,255,255,0.2);
      backdrop-filter: blur(6px);
      color: #fff;
      text-decoration: none;
      font-size: 12px;
      font-weight: 700;
      padding: 9px 14px;
      border-radius: 8px;
    }
    .btn-reel-vip {
      background: #e25352;
      color: #fff;
      text-decoration: none;
      font-size: 12px;
      font-weight: 700;
      padding: 9px 14px;
      border-radius: 8px;
      flex: 1;
      text-align: center;
    }
  </style>
</head>
<body>

  <div class="reels-topbar">
    <a href="/vitrine" class="top-pill">← Vitrine</a>
    <span style="font-weight:800;font-size:15px;letter-spacing:0.5px;">VIP <span style="color:#e25352;">REELS</span></span>
    <button id="mute-toggle-btn" class="top-pill" onclick="toggleGlobalMute()">🔇 Som</button>
  </div>

  <main class="reels-feed" id="reels-feed">
    ${slidesHtml}
  </main>

  <script>
    let isMuted = true;
    const videos = document.querySelectorAll('.reel-video');

    function toggleGlobalMute() {
      isMuted = !isMuted;
      videos.forEach(v => v.muted = isMuted);
      document.getElementById('mute-toggle-btn').innerText = isMuted ? '🔇 Som' : '🔊 Ativo';
    }

    function togglePlayPause(video) {
      if (video.paused) video.play();
      else video.pause();
    }

    function toggleLike(btn) {
      btn.classList.toggle('liked');
      const lbl = btn.querySelector('.label');
      const current = parseInt(lbl.innerText, 10) || 100;
      lbl.innerText = btn.classList.contains('liked') ? current + 1 : current - 1;
    }

    function shareReel(slug, name) {
      const url = location.origin + '/reels?modelo=' + encodeURIComponent(slug);
      if (navigator.share) {
        navigator.share({ title: 'VIP Reels - ' + name, url }).catch(() => {});
      } else {
        navigator.clipboard.writeText(url);
        alert('Link do Reel de ' + name + ' copiado!');
      }
    }

    // IntersectionObserver: dá play automático apenas no vídeo visível na tela
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const video = entry.target.querySelector('.reel-video');
        if (!video) return;
        if (entry.isIntersecting) {
          video.muted = isMuted;
          video.play().catch(() => {});
        } else {
          video.pause();
          video.currentTime = 0;
        }
      });
    }, { threshold: 0.65 });

    document.querySelectorAll('.reel-slide').forEach(slide => observer.observe(slide));
  </script>
</body>
</html>`;

    return reply.type('text/html; charset=utf-8').send(html);
  });
}