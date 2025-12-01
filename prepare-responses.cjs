// prepare-responses.cjs
// Етап 2: підготовка чернеток відповідей + оцінка годин/вартості для вибраних проєктів

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

// ==== КОНФІГ ====

// API-ключ
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
if (!OPENAI_API_KEY) {
  console.error('❌ Немає OPENAI_API_KEY у .env');
  process.exit(1);
}

// Модель для етапу 2
const OPENAI_MODEL_STAGE2 = process.env.OPENAI_MODEL_STAGE2 || 'gpt-5.1';

// Ставки для ринку України
const BASE_HOURLY_RATE_UAH = Number(process.env.BASE_HOURLY_RATE_UAH || 800);
const MIN_HOURLY_RATE_UAH = Number(process.env.MIN_HOURLY_RATE_UAH || 500);

// Множник для Європа/США (наприклад, 1.5x до UA)
const EU_US_PRICE_MULTIPLIER = Number(process.env.EU_US_PRICE_MULTIPLIER || 1.5);

// Дефолтні параметри етапу 2 (можна переписати прапорами CLI)
const DEFAULT_TOP_STAGE2 = Number(process.env.TOP_STAGE2 || 5);
const DEFAULT_BATCH_SIZE = Number(process.env.BATCH_SIZE_STAGE2 || 3);

const DEFAULT_DOMAIN_STAGE2 = (process.env.DOMAIN_STAGE2 || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const DEFAULT_WORKLOAD_STAGE2 = (process.env.WORKLOAD_STAGE2 || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ==== УТИЛІТИ ====

function truncate(str, max = 1000) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max) + '…';
}

// Парсер аргументів CLI
function parseArgs(argv) {
  const args = {
    file: null,

    // дефолтний ліміт з .env
    top: DEFAULT_TOP_STAGE2,

    // дефолтні фільтри з .env (якщо задані)
    ids: null,
    domain: DEFAULT_DOMAIN_STAGE2.length ? [...DEFAULT_DOMAIN_STAGE2] : null,
    workload: DEFAULT_WORKLOAD_STAGE2.length ? [...DEFAULT_WORKLOAD_STAGE2] : null,

    // дефолтний розмір батча з .env
    batchSize: DEFAULT_BATCH_SIZE,
  };

  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];

    // --file
    if (arg.startsWith('--file=')) {
      args.file = arg.split('=')[1];
      continue;
    }
    if (arg === '--file' && raw[i + 1]) {
      args.file = raw[++i];
      continue;
    }

    // --top
    if (arg.startsWith('--top=')) {
      args.top = Number(arg.split('=')[1] || String(DEFAULT_TOP_STAGE2)) || DEFAULT_TOP_STAGE2;
      continue;
    }
    if (arg === '--top' && raw[i + 1]) {
      args.top = Number(raw[++i] || String(DEFAULT_TOP_STAGE2)) || DEFAULT_TOP_STAGE2;
      continue;
    }

    // --ids
    if (arg.startsWith('--ids=')) {
      const val = arg.split('=')[1] || '';
      args.ids = val.split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (arg === '--ids' && raw[i + 1]) {
      const val = raw[++i];
      args.ids = val.split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }

    // --domain
    if (arg.startsWith('--domain=')) {
      const val = arg.split('=')[1] || '';
      args.domain = val
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      continue;
    }
    if (arg === '--domain' && raw[i + 1]) {
      const val = raw[++i];
      args.domain = val
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      continue;
    }

    // --workload
    if (arg.startsWith('--workload=')) {
      const val = arg.split('=')[1] || '';
      args.workload = val
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      continue;
    }
    if (arg === '--workload' && raw[i + 1]) {
      const val = raw[++i];
      args.workload = val
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      continue;
    }

    // --batch-size
    if (arg.startsWith('--batch-size=')) {
      args.batchSize =
        Number(arg.split('=')[1] || String(DEFAULT_BATCH_SIZE)) || DEFAULT_BATCH_SIZE;
      continue;
    }
    if (arg === '--batch-size' && raw[i + 1]) {
      args.batchSize =
        Number(raw[++i] || String(DEFAULT_BATCH_SIZE)) || DEFAULT_BATCH_SIZE;
      continue;
    }
  }

  return args;
}

function findLatestRecommendedFile() {
  const files = fs.readdirSync(__dirname);
  const candidates = files.filter((f) =>
    /^results-recommended-.*\.json$/.test(f),
  );
  if (!candidates.length) {
    console.error('❌ Не знайдено файлів results-recommended-*.json у поточній папці.');
    process.exit(1);
  }
  // Імена містять ISO-дату, тому лексикографічне сортування підійде
  candidates.sort();
  const latest = candidates[candidates.length - 1];
  return path.join(__dirname, latest);
}

function loadProjectsFromFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) {
    throw new Error('JSON у файлі не є масивом');
  }
  return arr;
}

// Локальна фільтрація проєктів для етапу 2
function filterProjects(projects, args) {
  let res = projects.filter((p) => p.fit !== false);

  // filter by domain (ads / analytics / crm_email / seo / dev_site / management / content_low / other)
  if (args.domain && args.domain.length) {
    const set = new Set(args.domain);
    res = res.filter(
      (p) =>
        p.domainCategory &&
        set.has(String(p.domainCategory).toLowerCase()),
    );
  }

  // filter by workload (tiny / small / medium / large / xl)
  if (args.workload && args.workload.length) {
    const set = new Set(args.workload);
    res = res.filter(
      (p) =>
        p.workload &&
        set.has(String(p.workload).toLowerCase()),
    );
  }

  // filter by explicit ids (якщо передано)
  if (args.ids && args.ids.length) {
    const idSet = new Set(args.ids.map(String));
    res = res.filter((p) => idSet.has(String(p.id)));
  } else if (args.top && args.top > 0 && res.length > args.top) {
    // якщо ids не передано — обрізаємо до top
    res = res.slice(0, args.top);
  }

  return res;
}

// ==== Взаємодія з GPT-5.1 ====

async function generateProposalsBatch(projectsBatch) {
  const systemPrompt =
    'Ти допомагаєш маркетологу Анастасії (Google Ads, Merchant Center / Shopping, Performance Max, GA4/GTM, SEO e-commerce, CRM, email-маркетинг, B2B) готувати відгуки на проєкти.' +
    ' Твоя задача — для кожного проєкту написати чернетку відповіді і дати адекватну оцінку по годинах та вартості ДЛЯ РИНКУ УКРАЇНИ.' +
    ' Вартість для Європи/США буде порахована окремо множенням на 1.5, тобто ти зараз працюєш тільки з українськими ставками.' +
    ' Відповіді мають бути професійні, по суті, без води, з фокусом на результат і технічну експертизу.' +
    ' Не використовуй зайву пунктуацію, не пиши пафосних вступів.' +
    ' Вважай, що базова комфортна ставка Анастасії ≈ ' + BASE_HOURLY_RATE_UAH + ' грн/год, мінімальна розумна ставка ≈ ' + MIN_HOURLY_RATE_UAH + ' грн/год.';

  const userLines = projectsBatch
    .map((p) => {
      return [
        `#id=${p.id}`,
        `Назва: ${p.title}`,
        `Категорія AI: ${p.category}`,
        `Доменна категорія: ${p.domainCategory}`,
        `Workload: ${p.workload}`,
        `Score: ${p.finalScore}`,
        `Бюджет: ${p.budgetStr} (≈ ${p.budgetUAH || 'невідомо'} грн)`,
        `URL: ${p.url}`,
        `Опис: ${truncate(p.description || '', 900)}`,
        '---',
      ].join('\n');
    })
    .join('\n');

  const userPrompt =
    'На основі цих проєктів підготуй ЧЕРНЕТКИ ВІДПОВІДЕЙ.' +
    '\nДля кожного проєкту створи обʼєкт з полями:' +
    '\n- id (рядок, той самий id),' +
    '\n- proposal (текст відповіді для відгуку на проєкт),' +
    '\n- estimate (обʼєкт з оцінкою задачі для ринку України).' +
    '\n\nСтруктура estimate:' +
    '\n- hours_min: мінімальна кількість годин (ціле число, може бути 1 для консультації),' +
    '\n- hours_max: максимальна кількість годин (ціле число, ≥ hours_min),' +
    '\n- hourly_rate_uah: орієнтовна погодинна ставка в гривнях (ціле число, в межах [' + MIN_HOURLY_RATE_UAH + '; ' + (BASE_HOURLY_RATE_UAH * 1.1).toFixed(0) + ']),' +
    '\n- total_min_uah: приблизна мінімальна вартість (hours_min * ставка),' +
    '\n- total_max_uah: приблизна максимальна вартість (hours_max * ставка),' +
    '\n- phases: масив етапів роботи, де кожен етап — обʼєкт { "name": "коротка назва", "hours": число }.' +
    '\n\nОрганізація годин:' +
    '\n- tiny: 1–2 години (консультація, невелика правка).' +
    '\n- small: ≈2–8 годин.' +
    '\n- medium: ≈8–20 годин.' +
    '\n- large: >20 годин.' +
    '\nУточнюй діапазон годин опираючись на workload і опис проєкту, але не стискай штучно, якщо задач багато.' +
    '\n\nВимоги до proposal:' +
    '\n- 1–3 коротких абзаци.' +
    '\n- Покажи, що ти розумієш нішу і біль замовника.' +
    '\n- Поясни, чому Анастасія підходить (Google Ads, GA4/GTM, Merchant Center / Shopping, PMax, SEO e-commerce, CRM, email, B2B — залежно від задачі).' +
    '\n- Додай короткий план з 3–5 кроків (аудит → налаштування → запуск → оптимізація → звітність).' +
    '\n- Не пиши конкретну погодинну ставку в тексті, можна дати тільки діапазон загальної вартості, якщо логічно.' +
    '\n- Пиши мовою оригінального опису проєкту (ukr/ru/en відповідно).' +
    '\n\nФормат ВІДПОВІДІ — ЧИСТИЙ JSON-масив, наприклад:' +
    '\n[{"id":"123","proposal":"...текст...","estimate":{"hours_min":5,"hours_max":8,"hourly_rate_uah":800,"total_min_uah":4000,"total_max_uah":6400,"phases":[{"name":"Аналіз і стратегія","hours":2},{"name":"Налаштування","hours":3}]}}]' +
    '\n\nОсь список проєктів:\n\n' +
    userLines;

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL_STAGE2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const text = resp.choices[0].message.content.trim();

  try {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1) {
      throw new Error('JSON array not found in model response');
    }
    const jsonStr = text.slice(start, end + 1);
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) throw new Error('Parsed JSON is not array');
    return parsed;
  } catch (e) {
    console.error('❌ Не вдалося розпарсити JSON з чернетками відповідей.');
    console.error('Відповідь моделі:\n', text);
    throw e;
  }
}

// ==== Основний сценарій ====

async function main() {
  const args = parseArgs(process.argv);

  const filePath = args.file || findLatestRecommendedFile();
  console.log(`Вхідний файл: ${path.basename(filePath)}`);

  const allProjects = loadProjectsFromFile(filePath);
  console.log(`У файлі ${allProjects.length} рекомендованих проєктів.`);

  const selected = filterProjects(allProjects, args);
  if (!selected.length) {
    console.log('Після фільтрації не залишилось жодного проєкту.');
    return;
  }

  console.log(
    `Обрано ${selected.length} проєкт(ів) для підготовки відповідей (batchSize=${args.batchSize}).`,
  );

  const proposals = [];

  for (let i = 0; i < selected.length; i += args.batchSize) {
    const batch = selected.slice(i, i + args.batchSize);
    console.log(
      `→ Готуємо відповіді для партії з ${batch.length} проєктів (з ${
        i + 1
      } по ${i + batch.length})...`,
    );

    const aiResult = await generateProposalsBatch(batch);
    const byId = new Map(batch.map((p) => [String(p.id), p]));

    aiResult.forEach((item) => {
      const project = byId.get(String(item.id));
      if (!project) return;

      const est = item.estimate || {};

      const hoursMin = est.hours_min != null ? Number(est.hours_min) : null;
      const hoursMax = est.hours_max != null ? Number(est.hours_max) : null;
      const hourlyRateUAH =
        est.hourly_rate_uah != null
          ? Number(est.hourly_rate_uah)
          : BASE_HOURLY_RATE_UAH;

      let totalMinUAH =
        est.total_min_uah != null ? Number(est.total_min_uah) : null;
      let totalMaxUAH =
        est.total_max_uah != null ? Number(est.total_max_uah) : null;

      if (hoursMin != null && hourlyRateUAH != null && totalMinUAH == null) {
        totalMinUAH = Math.round(hoursMin * hourlyRateUAH);
      }
      if (hoursMax != null && hourlyRateUAH != null && totalMaxUAH == null) {
        totalMaxUAH = Math.round(hoursMax * hourlyRateUAH);
      }

      const hourlyRateEUUS =
        hourlyRateUAH != null
          ? Math.round(hourlyRateUAH * EU_US_PRICE_MULTIPLIER)
          : null;

      const totalMinEUUS =
        totalMinUAH != null
          ? Math.round(totalMinUAH * EU_US_PRICE_MULTIPLIER)
          : null;
      const totalMaxEUUS =
        totalMaxUAH != null
          ? Math.round(totalMaxUAH * EU_US_PRICE_MULTIPLIER)
          : null;

      const phases = Array.isArray(est.phases) ? est.phases : [];

      proposals.push({
        id: project.id,
        title: project.title,
        description: project.description,
        url: project.url,
        category: project.category,
        domainCategory: project.domainCategory,
        workload: project.workload,
        finalScore: project.finalScore,
        budgetStr: project.budgetStr,
        budgetUAH: project.budgetUAH,
        reason: project.reason,
        proposal: item.proposal,
        estimate: {
          hoursMin,
          hoursMax,
          hourlyRateUAH,
          totalMinUAH,
          totalMaxUAH,
          hourlyRateUAH_EUUS: hourlyRateEUUS,
          totalMinUAH_EUUS: totalMinEUUS,
          totalMaxUAH_EUUS: totalMaxEUUS,
          phases,
        },
      });
    });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(
    __dirname,
    `proposals-${timestamp}.json`,
  );
  fs.writeFileSync(outFile, JSON.stringify(proposals, null, 2), 'utf8');

  console.log(
    `\nЗбережено ${proposals.length} пропозицій у файл: ${path.basename(
      outFile,
    )}\n`,
  );

  // Короткий вивід у консоль
  proposals.forEach((p) => {
    console.log('========================================');
    console.log(
      `ID: ${p.id} | score=${p.finalScore} | domain=${p.domainCategory || '-'} | workload=${p.workload || '-'}`,
    );
    console.log(`Назва: ${p.title}`);
    console.log(`URL: ${p.url}`);
    console.log(`Бюджет на платформі: ${p.budgetStr}`);
    if (p.estimate && p.estimate.hoursMin != null) {
      console.log(
        `UA: ${p.estimate.hoursMin}–${p.estimate.hoursMax} год, ~${p.estimate.totalMinUAH}–${p.estimate.totalMaxUAH} грн`,
      );
      console.log(
        `EU/US (x${EU_US_PRICE_MULTIPLIER}): ~${p.estimate.totalMinUAH_EUUS}–${p.estimate.totalMaxUAH_EUUS} грн`,
      );
    }
    console.log('\nЧернетка відгуку:\n');
    console.log(p.proposal);
    console.log('\n');
  });
}

main().catch((e) => {
  console.error('❌ Фатальна помилка (етап 2):', e);
  process.exit(1);
});
