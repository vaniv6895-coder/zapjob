import fs from 'fs';
import path from 'path';
import { getCreatorBySlug, listCreatorMedia, trackProfileEvent } from './portalDb.js';

const TEMPLATE_PATH = path.resolve('acompanhante.html');

function parseTagList(rawValue, fallback = []) {
  if (!rawValue) return fallback;
  if (Array.isArray(rawValue)) return rawValue.filter(Boolean);
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (!trimmed) return fallback;
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.filter(Boolean);
      } catch {}
    }
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return fallback;
}

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

    const isDemoAccount = String(creator.email || '').endsWith('@demo.com');
    let mediaList = await listCreatorMedia(creator.id, false);

    // Fallback apenas para contas de demonstração (@demo.com) sem mídias próprias
    if (mediaList.length === 0 && isDemoAccount) {
      mediaList = [
        {
          media_type: 'image',
          public_url: creator.avatar_url || 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=800&q=80',
        },
        {
          media_type: 'image',
          public_url: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=800&q=80',
        },
        {
          media_type: 'image',
          public_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&q=80',
        },
        {
          media_type: 'video',
          public_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
        },
      ];
    }

    // Separa fotos e vídeos reais para a galeria e Lightbox
    const visualMediaList = mediaList.filter((m) => m.media_type === 'image' || m.media_type === 'video');
    const photosCount = visualMediaList.filter((m) => m.media_type === 'image').length;
    const videosCount = visualMediaList.filter((m) => m.media_type === 'video').length;

    // Prioriza o áudio salvo diretamente no perfil (creator.audio_url) ou na galeria (media_type === 'audio')
    const audioMediaItem = mediaList.find((m) => m.media_type === 'audio');
    const finalAudioUrl =
      (creator.audio_url && String(creator.audio_url).trim()) ||
      (audioMediaItem && audioMediaItem.public_url) ||
      (isDemoAccount ? 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' : '');

    // Prioriza vídeo de verificação salvo no perfil ou na tabela creator_media
    const verifMediaItem = mediaList.find((m) => m.media_type === 'verification');
    const finalVerifUrl =
      (creator.verification_video_url && String(creator.verification_video_url).trim()) ||
      (verifMediaItem && verifMediaItem.public_url) ||
      '';

    const coverUrl =
      creator.cover_url ||
      creator.avatar_url ||
      (visualMediaList[0] && visualMediaList[0].public_url) ||
      'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=1200&q=80';

    const avatarUrl =
      creator.avatar_url ||
      creator.cover_url ||
      (visualMediaList[0] && visualMediaList[0].public_url) ||
      'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=500&q=80';

    // Barra de Áudio com duração real automática
    const waveHeights = [30, 55, 80, 45, 90, 60, 35, 75, 95, 50, 40, 85, 70, 30, 65, 90, 55, 40, 80, 60, 35, 75, 50, 85, 45, 70, 90, 40, 60, 35, 75, 50];
    const waveSpans = waveHeights.map((h) => `<span style="height:${h}%"></span>`).join('');

    const audioInjectionHtml = finalAudioUrl
      ? `<div class="audio-wave-bar">
           <button id="play-audio-btn" class="btn-wave-play" onclick="toggleAudio()">▶</button>
           <span class="wave-label">Ouça minha voz</span>
           <div id="waveform-bars" class="waveform-bars">${waveSpans}</div>
           <span id="wave-time-label" class="wave-time">0:00</span>
           <audio id="creator-audio" src="${finalAudioUrl}" preload="metadata" onloadedmetadata="updateAudioDuration()" ontimeupdate="updateAudioProgress()" onended="resetAudioUI()"></audio>
         </div>
         <script>
           function formatSecs(sec) {
             if (!sec || !isFinite(sec)) return '0:00';
             const m = Math.floor(sec / 60);
             const s = Math.floor(sec % 60);
             return m + ':' + String(s).padStart(2, '0');
           }
           function updateAudioDuration() {
             const audioEl = document.getElementById('creator-audio');
             const lbl = document.getElementById('wave-time-label');
             if (audioEl && lbl && isFinite(audioEl.duration)) {
               lbl.innerText = formatSecs(audioEl.duration);
             }
           }
           function updateAudioProgress() {
             const audioEl = document.getElementById('creator-audio');
             const lbl = document.getElementById('wave-time-label');
             if (audioEl && lbl && !audioEl.paused) {
               lbl.innerText = formatSecs(audioEl.currentTime);
             }
           }
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
             updateAudioDuration();
           }
         </script>`
      : '';

    // Bloco dedicado de Vídeo de Verificação
    const verificationSectionHtml = finalVerifUrl
      ? `<section class="verification-section">
           <div class="verif-card" onclick="openDirectMedia('${finalVerifUrl}', true)">
             <video src="${finalVerifUrl}#t=0.5" muted playsinline loop autoplay preload="metadata"></video>
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

    const rateValue = creator.hourly_rate || creator.half_hour_rate;
    const rateLabel = creator.hourly_rate ? '(1 hora)' : '(30 min)';
    const rateCardHtml = rateValue
      ? `<div class="big-info"><small>a partir de</small><br>R$ ${Number(rateValue).toFixed(0)} <small>${rateLabel}</small></div>`
      : `<div class="big-info"><small>valores</small><br>A combinar <small>(WhatsApp)</small></div>`;

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

    const bioText =
      (creator.bio && String(creator.bio).trim()) ||
      `Olá, me chamo ${creator.stage_name}! Atendimento VIP com total discrição, higiene e conforto. Entre em contato pelo WhatsApp para agendar nosso encontro.`;

    const defaultPhysical = [
      creator.height ? `${creator.height}` : null,
      creator.weight ? `${creator.weight}` : null,
      creator.has_location || 'Atendimento VIP',
    ].filter(Boolean);

    const physicalList = parseTagList(creator.physical_tags, defaultPhysical);
    const servicesList = parseTagList(creator.services_tags, ['Atendimento VIP', 'Acompanhante']);

    const physicalTagsHtml = physicalList.map((t) => `<span class="red-tag">${t}</span>`).join('');
    const servicesTagsHtml = servicesList.map((t) => `<span class="red-tag">${t}</span>`).join('');

    const workHoursText =
      creator.schedule_start && creator.schedule_end
        ? `${creator.schedule_start} - ${creator.schedule_end}`
        : '09:00 - 22:00';

    const mediaJson = JSON.stringify(visualMediaList.map((m) => ({ type: m.media_type, url: m.public_url })));

    let html = fs.readFileSync(TEMPLATE_PATH, 'utf8');

    html = html
      .replace(/\{\{STAGE_NAME\}\}/g, creator.stage_name || '')
      .replace(/\{\{CITY\}\}/g, creator.city || 'Várzea Grande')
      .replace(/\{\{STATE\}\}/g, creator.state || 'MT')
      .replace(/\{\{NEIGHBORHOOD\}\}/g, creator.neighborhood || 'Região Central')
      .replace(/\{\{AGE\}\}/g, String(creator.age || 24))
      .replace(/\{\{FOLLOWERS_COUNT\}\}/g, String(creator.followers_count || 148))
      .replace(/\{\{SPECIALTY_TAG\}\}/g, creator.specialty_tag || 'Atendimento VIP')
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
      .replace(/\{\{MEDIA_JSON\}\}/g, mediaJson)
      .replace('09:00 - 22:00', workHoursText);

    return reply.type('text/html; charset=utf-8').send(html);
  });
}