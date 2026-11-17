import fs from 'fs';
import path from 'path';
import { getCreatorBySlug, listCreatorMedia, trackProfileEvent } from './portalDb.js';

const TEMPLATE_PATH = path.resolve('acompanhate.html');

export function registerPortalProfileRoute(app) {
  app.get('/modelo/:slug', async (req, reply) => {
    const creator = await getCreatorBySlug(req.params.slug);
    if (!creator) {
      return reply
        .status(404)
        .type('text/html; charset=utf-8')
        .send('<body style="background:#eceff1;color:#263238;font-family:sans-serif;text-align:center;padding:50px"><h2>Perfil não encontrado ou aguardando verificação.</h2><a href="/vitrine" style="color:#e25352;font-weight:bold">Voltar para a Vitrine</a></body>');
    }

    await trackProfileEvent(creator.id, 'view');

    const mediaList = await listCreatorMedia(creator.id, false);
    const photosCount = mediaList.filter((m) => m.media_type === 'image').length;
    const videosCount = mediaList.filter((m) => m.media_type === 'video').length;

    const coverUrl = creator.cover_url || creator.avatar_url || 'https://placehold.co/960x360/263238/e25352?text=PORTAL+VIP';
    const avatarUrl = creator.avatar_url || creator.cover_url || 'https://placehold.co/300x300/263238/e25352?text=VIP';

    const isDiamond = creator.tier === 'diamond' && creator.featured_until && new Date(creator.featured_until) > new Date();
    const isVip = creator.tier === 'vip' && creator.featured_until && new Date(creator.featured_until) > new Date();

    const tierBadge = isDiamond
      ? '<span class="tier-badge tier-diamond">💎 LUXO DIAMANTE</span>'
      : isVip
      ? '<span class="tier-badge tier-vip">⭐ DESTAQUE VIP</span>'
      : '<span class="tier-badge tier-online">● ONLINE AGORA</span>';

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
    const replacements = {
      '{{STAGE_NAME}}': creator.stage_name,
      '{{CITY}}': creator.city,
      '{{STATE}}': creator.state,
      '{{SLUG}}': creator.slug,
      '{{COVER_URL}}': coverUrl,
      '{{AVATAR_URL}}': avatarUrl,
      '{{TIER_BADGE}}': tierBadge,
      '{{PHOTOS_COUNT}}': String(photosCount),
      '{{VIDEOS_COUNT}}': String(videosCount),
      '{{TOTAL_MEDIA}}': String(mediaList.length),
      '{{RATE_CARD_HTML}}': rateCardHtml,
      '{{BIO_TEXT}}': bioText,
      '{{BIO_META}}': bioText.slice(0, 140),
      '{{GALLERY_HTML}}': galleryHtml,
      '{{MEDIA_JSON}}': mediaJson,
    };

    for (const [key, val] of Object.entries(replacements)) {
      html = html.split(key).join(val);
    }

    return reply.type('text/html; charset=utf-8').send(html);
  });
}