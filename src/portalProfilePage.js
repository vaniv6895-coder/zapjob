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

    let mediaList = await listCreatorMedia(creator.id, false);

    // Fallback de demonstração para perfis fictícios/vazios (fotos, vídeo, vídeo de verificação e áudio)
    if (mediaList.length === 0) {
      mediaList = [
        {
          media_type: 'image',
          public_url: creator.avatar_url || 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=800&q=80'
        },
        {
          media_type: 'image',
          public_url: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=800&q=80'
        },
        {
          media_type: 'image',
          public_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&q=80'
        },
        {
          media_type: 'image',
          public_url: 'https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=800&q=80'
        },
        {
          media_type: 'image',
          public_url: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=800&q=80'
        },
        {
          media_type: 'video',
          public_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4'
        },
        {
          media_type: 'verification',
          public_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4'
        },
        {
          media_type: 'audio',
          public_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'
        }
      ];
    }

    // Separa apenas fotos e vídeos para a galeria e Lightbox
    const visualMediaList = mediaList.filter((m) => m.media_type === 'image' || m.media_type === 'video');
    const photosCount = visualMediaList.filter((m) => m.media_type === 'image').length;
    const videosCount = visualMediaList.filter((m) => m.media_type === 'video').length;

    const audioItem = mediaList.find((m) => m.media_type === 'audio');
    const verificationItem = mediaList.find((m) => m.media_type === 'verification');

    const coverUrl = creator.cover_url || creator.avatar_url || 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=1200&q=80';
    const avatarUrl = creator.avatar_url || creator.cover_url || 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=500&q=80';

    // Barra de Áudio com Ondas Sonoras
    const waveHeights = [30, 55, 80, 45, 90, 60, 35, 75, 95, 50, 40, 85, 70, 30, 65, 90, 55, 40, 80, 60, 35, 75, 50, 85, 45, 70, 90, 40, 60, 35, 75, 50];
    const waveSpans = waveHeights.map((h) => `<span style="height:${h}%"></span>`).join('');

    const audioInjectionHtml = audioItem
      ? `<div class="audio-wave-bar">
           <button id="play-audio-btn" class="btn-wave-play" onclick="toggleAudio()">▶</button>
           <span class="wave-label">Ouça minha voz</span>
           <div id="waveform-bars" class="waveform-bars">${waveSpans}</div>
           <span class="wave-time">0:25</span>
           <audio id="creator-audio" src="${audioItem.public_url}" onended="resetAudioUI()"></audio>
         </div>
         <script>
           function toggleAudio() {
             const audioEl = document.getElementById('creator-audio');
             const btn = document.getElementById('play-audio-btn');
             const wave = document.getElementById('waveform-bars');
             if (!audioEl || !audioEl.src) return;
             if (audioEl.paused) {
               audioEl.play();
               btn.innerText = '⏸';
               wave.classList.add('playing');
             } else {
               audioEl.pause();
               btn.innerText = '▶';
               wave.classList.remove('playing');
             }
           }
           function resetAudioUI() {
             document.getElementById('play-audio-btn').innerText = '▶';
             document.getElementById('waveform-bars').classList.remove('playing');
           }
         </script>`
      : '';

    // Bloco dedicado de Vídeo de Verificação
    const verificationSectionHtml = verificationItem
      ? `<section class="verification-section">
           <div class="verif-card" onclick="openDirectMedia('${verificationItem.public_url}', true)">
             <video src="${verificationItem.public_url}#t=0.5" muted playsinline loop autoplay preload="metadata"></video>
             <div style="position:absolute; top:14px; right:14px; background:rgba(0,0,0,0.65); color:#fff; font-size:11px; font-weight:700; padding:5px 10px; border-radius:99px;">▶ Vídeo de Verificação</div>
             <div class="verif-pills">
               <span class="v-pill"><i>✓</i> Corpo real</span>
               <span class="v-pill"><i>✓</i> Sem edição</span>
               <span class="v-pill"><i>✓</i> Doc. verificado</span>
             </div>
           </div>
           <details class="verif-accordion">
             <summary>
               <span>ⓘ O que é o vídeo de verificação?</span>
               <span>▾</span>
             </summary>
             <p>Este vídeo de comparação foi gravado e validado pela equipe do Portal VIP para garantir que a anunciante é real e corresponde exatamente às imagens do perfil.</p>
           </details>
         </section>`
      : '';

    const rateCardHtml = creator.hourly_rate
      ? `<div class="big-info"><small>a partir de</small><br>R$ ${Number(creator.hourly_rate).toFixed(0)} <small>(1 hora)</small></div>`
      : `<div class="big-info"><small>a partir de</small><br>R$ 300 <small>(1 hora)</small></div>`;

    const galleryHtml =
      visualMediaList.length === 0
        ? '<div style="grid-column:1/-1;text-align:center;padding:30px;color:#5d7a89">Nenhuma foto ou vídeo publicado ainda.</div>'
        : visualMediaList
            .map((m, idx) =>
              m.media_type === 'video'
                ? `<div class="media-tile" data-type="video" onclick="openLightbox(${idx})">
                    <video src="${m.public_url}#t=0.5" muted playsinline preload="metadata"></video>
                    <span class="video-badge">▶ Vídeo</span>
                   </div>`
                : `<div class="media-tile" data-type="image" onclick="openLightbox(${idx})">
                    <img src="${m.public_url}" alt="${creator.stage_name}" loading="lazy" />
                   </div>`
            )
            .join('');

    const bioText = creator.bio || `Olá, me chamo ${creator.stage_name}! Atendimento VIP com total discrição, higiene e conforto em local climatizado. Entre em contato pelo WhatsApp para agendar nosso encontro.`;

    const physicalList = ['1.68 m', '58 kg', 'Cabelo castanho', 'Olhos claros', 'Pele macia', 'Com local'];
    const servicesList = ['Atendimento VIP', 'Massagem relaxante', 'Massagem tântrica', 'Beijo na boca', 'Acompanhante para eventos'];

    const physicalTagsHtml = physicalList.map((t) => `<span class="red-tag">${t}</span>`).join('');
    const servicesTagsHtml = servicesList.map((t) => `<span class="red-tag">${t}</span>`).join('');

    const mediaJson = JSON.stringify(visualMediaList.map((m) => ({ type: m.media_type, url: m.public_url })));

    let html = fs.readFileSync(TEMPLATE_PATH, 'utf8');

    html = html
      .replace(/\{\{STAGE_NAME\}\}/g, creator.stage_name || '')
      .replace(/\{\{CITY\}\}/g, creator.city || 'Várzea Grande')
      .replace(/\{\{STATE\}\}/g, creator.state || 'MT')
      .replace(/\{\{NEIGHBORHOOD\}\}/g, creator.neighborhood || 'Centro / Região VIP')
      .replace(/\{\{AGE\}\}/g, String(creator.age || 24))
      .replace(/\{\{FOLLOWERS_COUNT\}\}/g, '148')
      .replace(/\{\{SPECIALTY_TAG\}\}/g, 'Atendimento VIP')
      .replace(/\{\{SLUG\}\}/g, creator.slug || '')
      .replace(/\{\{COVER_URL\}\}/g, coverUrl)
      .replace(/\{\{AVATAR_URL\}\}/g, avatarUrl)
      .replace(/\{\{AUDIO_INJECTION\}\}/g, audioInjectionHtml)
      .replace(/\{\{VERIFICATION_SECTION\}\}/g, verificationSectionHtml)
      .replace(/\{\{PHOTOS_COUNT\}\}/g, String(photosCount))
      .replace(/\{\{VIDEOS_COUNT\}\}/g, String(videosCount))
      .replace(/\{\{TOTAL_MEDIA\}\}/g, String(visualMediaList.length))
      .replace(/\{\{RATE_CARD_HTML\}\}/g, rateCardHtml)
      .replace(/\{\{BIO_TEXT\}\}/g, bioText)
      .replace(/\{\{BIO_META\}\}/g, bioText.slice(0, 145))
      .replace(/\{\{PHYSICAL_TAGS\}\}/g, physicalTagsHtml)
      .replace(/\{\{SERVICES_TAGS\}\}/g, servicesTagsHtml)
      .replace(/\{\{GALLERY_HTML\}\}/g, galleryHtml)
      .replace(/\{\{MEDIA_JSON\}\}/g, mediaJson);

    return reply.type('text/html; charset=utf-8').send(html);
  });
}