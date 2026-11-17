import fs from 'fs';
import path from 'path';
import { getCreatorBySlug, listCreatorMedia, trackProfileEvent } from './portalDb.js';

const TEMPLATE_PATH = path.resolve('acompanhante.html');

export function registerPortalProfileRoute(app) {
  app.get('/acompanhante/:slug', async (req, reply) => {
    const creator = await getCreatorBySlug(req.params.slug);
    if (!creator) {
      return reply
        .status(404)
        .type('text/html; charset=utf-8')
        .send('<body style="background:#eceff1;color:#263238;font-family:sans-serif;text-align:center;padding:50px"><h2>Perfil não encontrado ou aguardando verificação.</h2><a href="/vitrine" style="color:#e25352;font-weight:bold">Voltar para a Vitrine</a></body>');
    }

    await trackProfileEvent(creator.id, 'view');

    const mediaList = await listCreatorMedia(creator.id, false);
    
    // Filtros por tipo de mídia
    const photosCount = mediaList.filter((m) => m.media_type === 'image').length;
    const videosCount = mediaList.filter((m) => m.media_type === 'video').length;
    
    // Captura áudio e vídeo de verificação enviados pela criadora
    const audioItem = mediaList.find((m) => m.media_type === 'audio');
    const verificationItem = mediaList.find((m) => m.media_type === 'verification');

    const coverUrl = creator.cover_url || creator.avatar_url || 'https://placehold.co/960x360/263238/e25352?text=PORTAL+VIP';
    const avatarUrl = creator.avatar_url || creator.cover_url || 'https://placehold.co/300x300/263238/e25352?text=VIP';

    const isDiamond = creator.tier === 'diamond' && creator.featured_until && new Date(creator.featured_until) > new Date();
    const isVip = creator.tier === 'vip' && creator.featured_until && new Date(creator.featured_until) > new Date();

    const tierBadge = isDiamond
      ? '<span class="tier-badge tier-diamond">💎 LUXO DIAMANTE</span>'
      : isVip
      ? '<span class="tier-badge tier-vip">⭐ DESTAQUE VIP</span>'
      : '<span class="tier-badge tier-online">● ONLINE AGORA</span>';

    // Selo de vídeo de verificação (se houver)
    const verificationBadgeHtml = verificationItem
      ? `<a href="${verificationItem.public_url}" target="_blank" class="verified-badge" style="text-decoration:none; cursor:pointer;">✅ Vídeo de Verificação Verificado</a>`
      : '<div class="verified-badge">✓ Mídia de comparação verificada</div>';

    // Snippet do Player de Áudio (só injeta se a modelo tiver enviado áudio)
    const audioInjectionHtml = audioItem
      ? `<div id="audio-player-box" class="white-box section-pad" style="margin-top: 16px; padding: 18px 16px;">
           <h2 class="section-title">🎙️ Ouça minha voz</h2>
           <div style="display:flex; align-items:center; gap:12px; background:#f8fafc; padding:12px; border-radius:10px; border:1px solid #e2e9ed;">
             <button id="play-audio-btn" onclick="toggleAudio()" style="background:#e25352; color:#fff; border:none; width:44px; height:44px; border-radius:50%; font-size:18px; cursor:pointer; display:flex; align-items:center; justify-content:center;">▶</button>
             <div style="flex:1;">
               <strong style="display:block; font-size:13px; color:#263238;">Saudação exclusiva</strong>
               <span style="font-size:11px; color:#5d7a89;">Áudio verificado da modelo</span>
             </div>
             <audio id="creator-audio" src="${audioItem.public_url}"></audio>
           </div>
         </div>
         <script>
           function toggleAudio() {
             const audioEl = document.getElementById('creator-audio');
             const btn = document.getElementById('play-audio-btn');
             if (!audioEl.src) return;
             if (audioEl.paused) {
               audioEl.play();
               btn.innerText = '⏸';
             } else {
               audioEl.pause();
               btn.innerText = '▶';
             }
           }
         </script>`
      : '';

    const rateCardHtml = creator.hourly_rate
      ? `<div class="price-header">
          <span class="price-label">Cachê (1 hora)</span>
          <span class="price-val">R$ ${Number(creator.hourly_rate).toFixed(2).replace('.', ',')}</span>
         </div>`
      : `<div class="price-header">
          <span class="price-label">Cachê</span>
          <span class="price-val" style="font-size:15px;color:#5d7a89">Consultar no WhatsApp</span>
         </div>`;

    const galleryHtml =
      mediaList.length === 0
        ? '<div class="empty-msg">Nenhuma foto ou vídeo publicado na galeria ainda.</div>'
        : mediaList
            .filter((m) => m.media_type === 'image' || m.media_type === 'video')
            .map((m, idx) =>
              m.media_type === 'video'
                ? `<div class="media-tile" data-type="video" onclick="openLightbox(${idx})">
                    <video src="${m.public_url}#t=0.5" muted playsinline preload="metadata"></video>
                    <span class="video-tag">▶ Vídeo</span>
                   </div>`
                : `<div class="media-tile" data-type="image" onclick="openLightbox(${idx})">
                    <img src="${m.public_url}" alt="${creator.stage_name}" loading="lazy" />
                   </div>`
            )
            .join('');

    const bioText = creator.bio || 'Atendimento exclusivo com total discrição e segurança. Entre em contato pelo WhatsApp para agendar seu horário.';
    const mediaJson = JSON.stringify(mediaList.map((m) => ({ type: m.media_type, url: m.public_url })));

    let html = fs.readFileSync(TEMPLATE_PATH, 'utf8');

    html = html
      .replace(/\{\{STAGE_NAME\}\}/g, creator.stage_name || '')
      .replace(/\{\{CITY\}\}/g, creator.city || '')
      .replace(/\{\{STATE\}\}/g, creator.state || '')
      .replace(/\{\{SLUG\}\}/g, creator.slug || '')
      .replace(/\{\{COVER_URL\}\}/g, coverUrl)
      .replace(/\{\{AVATAR_URL\}\}/g, avatarUrl)
      .replace(/\{\{TIER_BADGE\}\}/g, tierBadge)
      .replace(/\{\{VERIFICATION_BADGE\}\}/g, verificationBadgeHtml)
      .replace(/\{\{AUDIO_INJECTION\}\}/g, audioInjectionHtml)
      .replace(/\{\{PHOTOS_COUNT\}\}/g, String(photosCount))
      .replace(/\{\{VIDEOS_COUNT\}\}/g, String(videosCount))
      .replace(/\{\{TOTAL_MEDIA\}\}/g, String(mediaList.length))
      .replace(/\{\{RATE_CARD_HTML\}\}/g, rateCardHtml)
      .replace(/\{\{BIO_TEXT\}\}/g, bioText)
      .replace(/\{\{BIO_META\}\}/g, bioText.slice(0, 140))
      .replace(/\{\{GALLERY_HTML\}\}/g, galleryHtml)
      .replace(/\{\{MEDIA_JSON\}\}/g, mediaJson);

    return reply.type('text/html; charset=utf-8').send(html);
  });
}