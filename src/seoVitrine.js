import fs from 'fs';
import path from 'path';

export function toGeoSlug(text = '') {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function unslugTitle(slug = '') {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function escapeHtml(str = '') {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function ensureGeoSeoColumns(pool) {
  await pool.query(`
    ALTER TABLE creators
      ADD COLUMN IF NOT EXISTS country_code VARCHAR(8) DEFAULT 'br',
      ADD COLUMN IF NOT EXISTS neighborhood VARCHAR(120),
      ADD COLUMN IF NOT EXISTS city_slug VARCHAR(140),
      ADD COLUMN IF NOT EXISTS neighborhood_slug VARCHAR(140);
  `).catch(() => {});

  // Preenche slugs retroativos para perfis já cadastrados
  await pool.query(`
    UPDATE creators
    SET
      country_code = LOWER(COALESCE(NULLIF(country_code, ''), 'br')),
      city_slug = LOWER(REGEXP_REPLACE(TRANSLATE(COALESCE(city, ''), 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'), '[^a-zA-Z0-9]+', '-', 'g')),
      neighborhood_slug = LOWER(REGEXP_REPLACE(TRANSLATE(COALESCE(neighborhood, ''), 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'), '[^a-zA-Z0-9]+', '-', 'g'))
    WHERE city IS NOT NULL AND (city_slug IS NULL OR city_slug = '');
  `).catch(() => {});

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_creators_geo_seo
    ON creators (country_code, city_slug, neighborhood_slug, featured_until DESC);
  `).catch(() => {});
}

export function registerSeoVitrineRoutes(app, pool) {
  // 1. API de busca geográfica com prioridade para perfis IMPULSIONADOS no bairro e fallback na cidade
  app.get('/api/vitrine/geo', async (req, reply) => {
    try {
      const country = toGeoSlug(req.query.country || 'br') || 'br';
      const citySlug = toGeoSlug(req.query.city || '');
      const neighborhoodSlug = toGeoSlug(req.query.neighborhood || '');

      if (!citySlug) {
        const allRes = await pool.query(`
          SELECT id, slug, stage_name, city, state, neighborhood, country_code, avatar_url, tier, featured_until,
                 (featured_until IS NOT NULL AND featured_until > NOW()) AS is_boosted,
                 1 AS geo_priority
          FROM creators
          WHERE is_active = TRUE
          ORDER BY (featured_until IS NOT NULL AND featured_until > NOW()) DESC, featured_until DESC NULLS LAST, created_at DESC
          LIMIT 60
        `);
        return reply.send({ ok: true, items: allRes.rows });
      }

      const res = await pool.query(
        `
        SELECT
          id, slug, stage_name, city, state, neighborhood, country_code, avatar_url, tier, featured_until,
          (featured_until IS NOT NULL AND featured_until > NOW()) AS is_boosted,
          CASE
            WHEN $3 <> '' AND neighborhood_slug = $3 THEN 1
            ELSE 2
          END AS geo_priority
        FROM creators
        WHERE is_active = TRUE
          AND LOWER(COALESCE(country_code, 'br')) = $1
          AND city_slug = $2
        ORDER BY
          geo_priority ASC,
          (featured_until IS NOT NULL AND featured_until > NOW()) DESC,
          featured_until DESC NULLS LAST,
          created_at DESC
        LIMIT 80
        `,
        [country, citySlug, neighborhoodSlug]
      );

      // Também retorna lista de bairros ativos naquela cidade para links internos de SEO
      const hoodsRes = await pool.query(
        `
        SELECT DISTINCT neighborhood, neighborhood_slug
        FROM creators
        WHERE is_active = TRUE
          AND LOWER(COALESCE(country_code, 'br')) = $1
          AND city_slug = $2
          AND neighborhood_slug IS NOT NULL
          AND neighborhood_slug <> ''
        ORDER BY neighborhood ASC
        LIMIT 40
        `,
        [country, citySlug]
      );

      return reply.send({
        ok: true,
        geo: { country, citySlug, neighborhoodSlug },
        neighborhoods: hoodsRes.rows,
        items: res.rows,
      });
    } catch (err) {
      return reply.status(500).send({ error: 'Erro ao carregar vitrine local.' });
    }
  });

  // 2. Rotas HTML indexáveis: /vitrine/:country/:city e /vitrine/:country/:city/:neighborhood
  const serveGeoVitrineHtml = async (req, reply) => {
    const country = toGeoSlug(req.params.country || 'br') || 'br';
    const citySlug = toGeoSlug(req.params.city || '');
    const neighborhoodSlug = toGeoSlug(req.params.neighborhood || '');

    const cityLabel = unslugTitle(citySlug);
    const hoodLabel = unslugTitle(neighborhoodSlug);
    const placeLabel = hoodLabel ? `${hoodLabel}, ${cityLabel}` : cityLabel;

    const seoTitle = placeLabel
      ? `Garota VIP em ${placeLabel} — Perfis Verificados e Clube VIP`
      : 'Garota VIP — Vitrine Global e Clube VIP';
    const seoDesc = placeLabel
      ? `Veja perfis verificados e destaques VIP em ${placeLabel}. Fotos exclusivas, contato direto e acesso ao Clube VIP.`
      : 'Explore perfis verificados e Clubes VIP na sua cidade e bairro.';

    const publicBase = (process.env.PUBLIC_URL || `${req.protocol}://${req.hostname}`).replace(/\/$/, '');
    const canonicalPath = neighborhoodSlug
      ? `/vitrine/${country}/${citySlug}/${neighborhoodSlug}`
      : `/vitrine/${country}/${citySlug}`;
    const canonicalUrl = `${publicBase}${canonicalPath}`;

    const vitrinePath = path.join(process.cwd(), 'public', 'vitrine.html');
    if (!fs.existsSync(vitrinePath)) {
      return reply.redirect(`/vitrine?country=${country}&city=${citySlug}&neighborhood=${neighborhoodSlug}`);
    }

    let html = fs.readFileSync(vitrinePath, 'utf8');

    // Injeta Title, Description, Canonical e contexto inicial de SEO para o Google e para o front-end
    const seoHeadBlock = `
  <title>${escapeHtml(seoTitle)}</title>
  <meta name="description" content="${escapeHtml(seoDesc)}" />
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  <meta property="og:title" content="${escapeHtml(seoTitle)}" />
  <meta property="og:description" content="${escapeHtml(seoDesc)}" />
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
  <script>
    window.__INITIAL_GEO_SEO__ = ${JSON.stringify({
      country,
      citySlug,
      neighborhoodSlug,
      cityLabel,
      hoodLabel,
      placeLabel,
    })};
  </script>`;

    html = html.replace(/<title>[\s\S]*?<\/title>/i, seoHeadBlock);
    return reply.type('text/html; charset=utf-8').send(html);
  };

  app.get('/vitrine/:country/:city', serveGeoVitrineHtml);
  app.get('/vitrine/:country/:city/:neighborhood', serveGeoVitrineHtml);

  // 3. Sitemap.xml dinâmico para indexar todas as cidades, bairros e perfis no Google
  app.get('/sitemap.xml', async (req, reply) => {
    try {
      const publicBase = (process.env.PUBLIC_URL || `${req.protocol}://${req.hostname}`).replace(/\/$/, '');

      const [geoRows, creatorRows] = await Promise.all([
        pool.query(`
          SELECT DISTINCT
            LOWER(COALESCE(NULLIF(country_code, ''), 'br')) AS country_code,
            city_slug,
            neighborhood_slug
          FROM creators
          WHERE is_active = TRUE AND city_slug IS NOT NULL AND city_slug <> ''
        `),
        pool.query(`
          SELECT slug, updated_at
          FROM creators
          WHERE is_active = TRUE AND slug IS NOT NULL AND slug <> ''
          ORDER BY updated_at DESC NULLS LAST
          LIMIT 2000
        `),
      ]);

      const urls = new Set([`${publicBase}/`, `${publicBase}/vitrine`]);

      for (const row of geoRows.rows) {
        urls.add(`${publicBase}/vitrine/${row.country_code}/${row.city_slug}`);
        if (row.neighborhood_slug) {
          urls.add(`${publicBase}/vitrine/${row.country_code}/${row.city_slug}/${row.neighborhood_slug}`);
        }
      }

      for (const c of creatorRows.rows) {
        urls.add(`${publicBase}/vip/${c.slug}`);
      }

      const xmlItems = Array.from(urls)
        .map(
          (loc) => `  <url>
    <loc>${escapeHtml(loc)}</loc>
    <changefreq>daily</changefreq>
    <priority>${loc.includes('/vip/') ? '0.8' : '0.9'}</priority>
  </url>`
        )
        .join('\n');

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${xmlItems}
</urlset>`;

      return reply.type('application/xml; charset=utf-8').send(xml);
    } catch {
      return reply.status(500).send('Erro ao gerar sitemap');
    }
  });
}