// index.cjs
// Автовідбір проєктів з Freelancehunt для маркетолога
// Підсилені Merchant Center / Shopping, знижений пріоритет менеджерських ролей,
// збереження повного результату у JSON (відсортовано за пріоритетом) +
// окремий JSON із рекомендованими (fit=true) + доменні категорії та workload.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

// ==== КОНФІГ ====

const FH_TOKEN =
  process.env.FREELANCEHUNT_TOKEN ||
  process.env.FH_TOKEN ||
  '';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
// модель для етапу 1 (дешевша); за замовчуванням можна ставити що завгодно й перекрити через .env
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

// скільки максимум проєктів тягнемо з Freelancehunt за один запуск
const MAX_PROJECTS_TO_LOAD = Number(process.env.MAX_PROJECTS_TO_LOAD || 400);
// мінімальний бюджет у гривнях (проєкти без бюджету все одно пропускаємо, якщо релевантні)
const MIN_BUDGET_UAH = Number(process.env.MIN_BUDGET_UAH || 1000);
// скільки проєктів віддаємо в одну партію моделі
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 8);

const FULL_MODE = process.argv.includes('--full'); // ігнорувати seen-projects.json

const SEEN_FILE = path.join(__dirname, 'seen-projects.json');

if (!FH_TOKEN) {
  console.error('❌ Немає FREELANCEHUNT_TOKEN / FH_TOKEN у .env');
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error('❌ Немає OPENAI_API_KEY у .env');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ==== УТИЛІТИ ====

async function doFetch(url, options) {
  if (typeof fetch === 'function') {
    return fetch(url, options);
  }
  const { default: fetchFn } = await import('node-fetch');
  return fetchFn(url, options);
}

function budgetToUAH(amount, currency) {
  if (amount == null) return null;
  const cur = (currency || '').toUpperCase();
  if (!cur || cur === 'UAH' || cur === 'ГРН') return amount;
  if (cur === 'USD' || cur === '$') return amount * 40;
  if (cur === 'EUR' || cur === '€') return amount * 43;
  if (cur === 'PLN') return amount * 10;
  return amount;
}

function normalizeBudget(attrsBudget) {
  if (!attrsBudget || typeof attrsBudget !== 'object') {
    return { amount: null, currency: null, raw: 'невідомо', uah: null };
  }
  const amount =
    attrsBudget.amount ??
    attrsBudget.value ??
    attrsBudget.budget ??
    null;
  const currency =
    attrsBudget.currency ||
    attrsBudget.currency_code ||
    attrsBudget.code ||
    null;

  if (amount == null) {
    return {
      amount: null,
      currency,
      raw: 'невідомо',
      uah: null,
    };
  }
  const uah = budgetToUAH(Number(amount), currency);
  return {
    amount: Number(amount),
    currency,
    raw: `${amount} ${currency || ''}`.trim(),
    uah,
  };
}

function loadSeen() {
  try {
    const raw = fs.readFileSync(SEEN_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) {
    return new Set();
  }
}

function saveSeen(seenSet) {
  const arr = Array.from(seenSet);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

function truncate(str, max = 900) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max) + '…';
}

// ==== КЛЮЧОВІ СЛОВА ====

const HIGH_PRIORITY_KEYWORDS = [
  // General performance / digital marketing
  'digital маркетинг',
  'діджитал маркетинг',
  'digital marketing',
  'performance marketing',
  'performance-маркетинг',
  'інтернет-маркетинг',
  'интернет маркетинг',
  'online marketing',
  'маркетингова стратегія',
  'маркетинговая стратегия',
  'контекстна реклама',
  'контекстная реклама',
  'онлайн реклама',
  'реклама в інтернеті',
  'реклама в интернете',
  'налаштувати рекламу',
  'настроить рекламу',
  'настройка рекламы',
  'запуск реклами',
  'запуск рекламы',
  'рекламні кампанії',
  'рекламные кампании',
  'ppc',
  'sem',

  // Google Ads / Shopping / PMax
  'google ads',
  'google adwords',
  'google реклама',
  'гугл реклама',
  'реклама в google',
  'search ads',
  'google search',
  'google shopping',
  'shopping ads',
  'merchant center',
  'google merchant center',
  'performance max',
  'pmax',
  'smart shopping',
  'динамічний ремаркетинг',
  'динамический ремаркетинг',
  'dynamic remarketing',
  'ремаркетинг',
  'ретаргетинг',
  'product feed',
  'product feeds',

  // Analytics / tracking / GA4 / GTM
  'ga4',
  'google analytics 4',
  'google analytics',
  'universal analytics',
  'gtm',
  'google tag manager',
  'tag manager',
  'data layer',
  'datalayer',
  'web-аналітика',
  'веб аналітика',
  'веб аналитика',
  'web analytics',
  'аналітика сайту',
  'аналитика сайта',
  'events tracking',
  'conversion tracking',
  'конверсії',
  'конверсии',
  'налаштування подій',
  'настройка событий',
  'server-side tracking',
  'server side tracking',
  'server-side tagging',
  'offline conversions',
  'offline-конверсії',
  'utm-мітки',
  'utm метки',
  'utm разметка',
  'bigquery',
  'looker studio',
  'datastudio',
  'data studio',

  // E-commerce / платформи
  'інтернет-магазин',
  'интернет магазин',
  'online store',
  'ecommerce',
  'e-commerce',
  'shopify',
  'магазин shopify',
  'woocommerce',
  'woo commerce',
  'opencart',
  'open cart',
  'magento',
  'prestashop',
  'presta shop',
  'cs-cart',
  'bigcommerce',
  'prom.ua',

  // Email / CRM / funnels
  'email-маркетинг',
  'email маркетинг',
  'email marketing',
  'email рассылка',
  'e-mail рассылка',
  'email розсилка',
  'розсилка',
  'розсилки',
  'рассылки',
  'newsletter',
  'klaviyo',
  'mailchimp',
  'sendpulse',
  'omnisend',
  'smtp',
  'crm',
  'amo crm',
  'amocrm',
  'bitrix24',
  'hubspot',
  'pipedrive',
  'salesforce',
  'автоворонка',
  'воронка продаж',
  'воронка продажів',
  'sales funnel',
  'lead nurturing',

  // B2B / leadgen
  'b2b',
  'b2b marketing',
  'b2b leadgen',
  'b2b lead gen',
  'лідогенерація',
  'лидогенерация',
  'lead generation',
  'b2b sales',
  'appointment setting',

  // Social ads (додатковий профіль)
  'facebook ads',
  'meta ads',
  'instagram ads',
  'tiktok ads',
  'linkedin ads',
  'реклама в facebook',
  'реклама в instagram',
  'реклама в tiktok',
  'реклама в linkedin',
  'реклама в соцмережах',
  'реклама в соцсетях',
  'таргетована реклама',
  'таргетированная реклама',
  'paid social',
  'ads manager',
  'рекламний кабінет',
  'рекламный кабинет',
];

const LOW_PRIORITY_EXCLUDE_KEYWORDS = [
  'копірайт',
  'копирайт',
  'стаття',
  'статей',
  'article',
  'логотип',
  'logo',
  'банер',
  'баннера',
  'баннер',
  'web-дизайн',
  'web design',
  'веб-дизайн',
  'відео монтаж',
  'монтаж відео',
  'озвучка',
  'voice over',
  'переклад',
  'translation',
  'перекладач',
  'відеоролик',
];

// ==== 1. Тягнемо проєкти з Freelancehunt ====

async function fetchFreelancehuntProjects(limit = MAX_PROJECTS_TO_LOAD) {
  console.log('→ Тягнемо проєкти з Freelancehunt...');
  let projects = [];
  let page = 1;
  let hasNext = true;

  while (projects.length < limit && hasNext) {
    const url = `https://api.freelancehunt.com/v2/projects?page[number]=${page}&page[size]=50`;

    const res = await doFetch(url, {
      headers: {
        Authorization: `Bearer ${FH_TOKEN}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      console.error('❌ Помилка запиту до Freelancehunt:', res.status, res.statusText);
      const text = await res.text();
      console.error(text);
      break;
    }

    const json = await res.json();
    const data = Array.isArray(json.data) ? json.data : [];

    const mapped = data.map((item) => {
      const id = String(item.id);
      const attrs = item.attributes || {};
      const title =
        attrs.name ||
        attrs.title ||
        attrs.project_name ||
        `Без назви #${id}`;
      const description =
        attrs.description ||
        attrs.project_description ||
        '';

      const budget = normalizeBudget(attrs.budget);
      const statusRaw =
        (attrs.status && (attrs.status.name || attrs.status.label || attrs.status.id)) ||
        attrs.state ||
        '';

      const status = String(statusRaw || '').trim();

      const urlWeb =
        (item.links && (item.links.self_web || item.links.self?.web)) ||
        (item.links && item.links.self) ||
        `https://freelancehunt.com/project/${id}.html`;

      const createdAt = attrs.published_at || attrs.created_at || null;

      // дуже м'який фільтр "приймає ставки": відсікаємо лише явно закриті
      const isAcceptingBids = !/закр|closed|заверш|done|finished/i.test(status);

      return {
        id,
        title,
        description,
        budget,
        status,
        isAcceptingBids,
        url: urlWeb,
        createdAt,
      };
    });

    projects.push(...mapped);

    const nextLink =
      (json.links && (json.links.next || json.links['next'])) || null;
    hasNext = Boolean(nextLink);
    page += 1;
  }

  if (projects.length > limit) {
    projects = projects.slice(0, limit);
  }

  console.log(`Отримали ${projects.length} проєктів з кількох сторінок.`);
  return projects;
}

// ==== 2. Локальний префільтр (статус + бюджет + ключові слова) ====

function prefilterProjects(allProjects) {
  const afterStatus = allProjects.filter((p) => p.isAcceptingBids !== false);
  console.log(
    `Після фільтра по статусу "приймає ставки" залишилось ${afterStatus.length} проєктів.`,
  );

  const res = afterStatus.filter((p) => {
    const text = `${p.title} \n ${p.description}`.toLowerCase();

    // якщо суто "заповнення карток" (але ти хочеш їх бачити як низький пріоритет) —
    // пропускаємо, але AI вже поставить низький score
    const isPureContent =
      /карток товарів|картки товарів|карточек товаров|наполнен/i.test(text) &&
      !/google|ads|merchant|shopping|seo|ga4|gtm|crm|email/i.test(text);

    // виключити дуже нецільові
    const hasBadKeyword = LOW_PRIORITY_EXCLUDE_KEYWORDS.some((k) =>
      text.includes(k),
    );

    if (hasBadKeyword && !/google|ads|seo|ga4|crm|shopping|merchant/i.test(text)) {
      return false;
    }

    // хоча б одне релевантне слово
    const hasGoodKeyword = HIGH_PRIORITY_KEYWORDS.some((k) =>
      text.includes(k),
    );
    if (!hasGoodKeyword && !isPureContent) {
      return false;
    }

    // бюджет: або достатній, або не вказаний
    const budgetOk =
      p.budget.uah == null || p.budget.uah >= MIN_BUDGET_UAH;

    return budgetOk;
  });

  console.log(
    `Після префільтра (бюджет + ключі) залишилось ${res.length} проєктів.`,
  );
  return res;
}

// ==== 3. Взаємодія з моделлю ====

async function evaluateBatchWithAI(projectsBatch) {
  const systemPrompt =
    'Ти — асистент, який допомагає маркетологу (Google Ads, Merchant Center/Shopping, SEO, GA4/GTM, CRM, email, B2B) обирати проєкти на Freelancehunt.' +
    ' Для кожного проєкту оціни, наскільки він підходить під технічний маркетинг/рекламу/аналітику.' +
    ' ВАЖЛИВО: завдання по Google Merchant Center / Google Shopping / Performance Max / фідах мають один із НАЙВИЩИХ пріоритетів.' +
    ' Менеджерські ролі (Lead Generation Manager, marketing manager тощо) не виключай, але став їм трошки нижчий пріоритет, ніж чистим технічним задачам по рекламі/аналітиці.';

  const userLines = projectsBatch
    .map((p) => {
      return [
        `#id=${p.id}`,
        `Назва: ${p.title}`,
        `Бюджет: ${p.budget.raw}`,
        `Опис: ${truncate(p.description, 900)}`,
        '---',
      ].join('\n');
    })
    .join('\n');

  const userPrompt =
    'Проаналізуй наступні проєкти. Для КОЖНОГО поверни обʼєкт JSON з полями:' +
    ' id (рядок, той самий id),' +
    ' fit (true/false),' +
    ' score (ціле 1..10),' +
    ' category (одне з: "core_paid", "core_noprice", "site_full", "managerial", "low_priority_cards", "other"),' +
    ' domainCategory (одне з: "ads", "analytics", "crm_email", "seo", "dev_site", "management", "content_low", "other"),' +
    ' workload (одне з: "tiny", "small", "medium", "large"),' +
    ' reason (коротке пояснення українською).' +
    '\n\n' +
    'Пояснення полів:\n' +
    '- domainCategory="ads" — задачі по рекламі (Google Ads, PMax, Shopping, Meta/TikTok Ads та інший платний трафік).\n' +
    '- domainCategory="analytics" — GA4, GTM, події, DataLayer, звітність, server-side, BigQuery/Looker Studio.\n' +
    '- domainCategory="crm_email" — email-розсилки, CRM, автоворонки, лід-менеджмент.\n' +
    '- domainCategory="seo" — SEO-оптимізація сайту/контенту.\n' +
    '- domainCategory="dev_site" — розробка/правки сайтів, верстка, технічні правки без акценту саме на рекламі.\n' +
    '- domainCategory="management" — менеджерські/leadgen-ролі, коли основне — управління процесом/командою.\n' +
    '- domainCategory="content_low" — наповнення карток, рутинний контент без стратегії.\n' +
    '- domainCategory="other" — усе, що не вписується вище.\n\n' +
    'workload описує обсяг задачі:\n' +
    '- "tiny" — до 2 годин (консультація, дрібна правка).\n' +
    '- "small" — ~2–8 годин.\n' +
    '- "medium" — ~8–20 годин.\n' +
    '- "large" — >20 годин.\n\n' +
    'Правила ранжування:\n' +
    '1) score 9–10, category "core_*" — ключові задачі: Google Ads, Merchant Center/Shopping, Performance Max/PMax, GA4/GTM, SEO для e-commerce, CRM/автоворонки, email-маркетинг, B2B digital.\n' +
    '   Особливо підсилюй Merchant Center / Shopping / PMax.\n' +
    '2) category "managerial" — вакансії типу Lead Generation Manager, Marketing Manager. Вони fit=true, але score трохи нижче.\n' +
    '3) category "site_full" — створення/оптимізація сайтів під SEO/швидкість.\n' +
    '4) category "low_priority_cards" — наповнення/редагування карток товарів.\n' +
    '5) Все, що не про маркетинг/аналітику — fit=false, score 1–4, category "other".\n\n' +
    'Виведи ЧИСТИЙ JSON-масив без пояснень, наприклад:\n' +
    '[{"id":"123","fit":true,"score":9,"category":"core_paid","domainCategory":"ads","workload":"small","reason":"..."}, ...]\n\n' +
    userLines;

const resp = await openai.chat.completions.create({
  model: OPENAI_MODEL,
  // temperature не задаємо — деякі моделі GPT-5 підтримують тільки дефолт
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ],
});


  const text = resp.choices[0].message.content.trim();

  let jsonStr;
  try {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1) {
      throw new Error('JSON array not found in model response');
    }
    jsonStr = text.slice(start, end + 1);
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) throw new Error('Parsed JSON is not array');
    return parsed;
  } catch (e) {
    console.error('❌ Не вдалося розпарсити JSON від моделі.');
    console.error('Відповідь моделі:\n', text);
    throw e;
  }
}

// ручне підсилення Merchant / зниження менеджерських
function applyManualPriorityTuning(project, evalItem) {
  const textAll = `${project.title}\n${project.description}\n${evalItem.reason || ''}`.toLowerCase();

  const isMerchant =
    /merchant center|google shopping|shopping|performance max|pmax|фід|фида|фиду|feed/i.test(
      textAll,
    );
  const isManagerial =
    /manager|менеджер|lead generation manager|marketing manager/i.test(
      project.title.toLowerCase(),
    );
  const isCards =
    /карток товарів|картки товарів|карточек товаров|наполнен/i.test(textAll);
  const isSiteFull =
    /(создание|створення|розробка).*(сайта|сайту|интернет-магазина|інтернет-магазину|landing)|internet shop|internet store/i.test(
      textAll,
    );

  let score = Number(evalItem.score || 0);
  if (Number.isNaN(score)) score = 0;

  // Підсилюємо Merchant / Shopping / PMax
  if (isMerchant && evalItem.fit) {
    if (score < 9) {
      score = Math.min(10, score + 2);
    }
  }

  // Занижуємо менеджерські (але не менше 5)
  if (isManagerial && evalItem.fit) {
    score = Math.max(5, score - 1);
  }

  let category = evalItem.category || 'other';
  if (isCards) category = 'low_priority_cards';
  else if (isSiteFull && category === 'other') category = 'site_full';
  else if (isManagerial) category = 'managerial';

  // domainCategory та workload беремо з моделі, але трошки підправляємо за потреби
  let domainCategory = evalItem.domainCategory || null;
  if (!domainCategory) {
    if (isMerchant) domainCategory = 'ads';
    else if (isSiteFull) domainCategory = 'dev_site';
    else if (isManagerial) domainCategory = 'management';
  }

  const workload = evalItem.workload || null;

  return {
    ...evalItem,
    score,
    finalScore: score,
    isMerchant,
    isManagerial,
    category,
    domainCategory,
    workload,
  };
}

// сортування: fit → score → наявність бюджету → бюджет у грн
function sortByPriority(a, b) {
  if (a.fit !== b.fit) return a.fit ? -1 : 1;
  if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;

  const aHasBudget = a.budgetUAH != null;
  const bHasBudget = b.budgetUAH != null;
  if (aHasBudget !== bHasBudget) return aHasBudget ? -1 : 1;

  return (b.budgetUAH || 0) - (a.budgetUAH || 0);
}

// ==== 4. Основний сценарій ====

async function main() {
  const seen = loadSeen();
  console.log(`(Історія) Уже бачили проєктів: ${seen.size}`);
  console.log(
    `Режим: ${FULL_MODE ? 'FULL (ігноруємо seen при відборі)' : 'NORMAL (фільтруємо вже бачені id)'}`,
  );
  console.log(
    `Параметри: MAX_PROJECTS_TO_LOAD=${MAX_PROJECTS_TO_LOAD}, MIN_BUDGET_UAH=${MIN_BUDGET_UAH}, MODEL=${OPENAI_MODEL}`,
  );

  const allProjects = await fetchFreelancehuntProjects(MAX_PROJECTS_TO_LOAD);
  const prefiltered = prefilterProjects(allProjects);

  let projectsForAI;
  if (FULL_MODE) {
    console.log(
      `FULL: ігноруємо seen-projects.json, до моделі піде ${prefiltered.length} проєктів.`,
    );
    projectsForAI = prefiltered;
  } else {
    const unseen = prefiltered.filter((p) => !seen.has(p.id));
    console.log(
      `NORMAL: з ${prefiltered.length} префільтрованих проєктів ${unseen.length} ще не дивились (решта вже в seen-projects.json).`,
    );
    projectsForAI = unseen;
  }

  if (!projectsForAI.length) {
    console.log('Немає нових проєктів для аналізу. ✅');
    return;
  }

  // === 4.1. Гонимо в модель батчами ===

  const evaluatedRecords = [];

  for (let i = 0; i < projectsForAI.length; i += BATCH_SIZE) {
    const batch = projectsForAI.slice(i, i + BATCH_SIZE);
    console.log(
      `→ Оцінюємо партію з ${batch.length} проєктів (з ${
        i + 1
      } по ${i + batch.length})...`,
    );

    const aiResult = await evaluateBatchWithAI(batch);

    const byId = new Map(batch.map((p) => [String(p.id), p]));

    aiResult.forEach((r) => {
      const project = byId.get(String(r.id));
      if (!project) return;

      const tuned = applyManualPriorityTuning(project, r);

      const record = {
        id: project.id,
        title: project.title,
        description: project.description,
        url: project.url,
        budgetStr: project.budget.raw,
        budgetUAH: project.budget.uah,
        fit: Boolean(tuned.fit),
        score: Number(r.score || 0),
        finalScore: Number(tuned.finalScore || tuned.score || 0),
        category: tuned.category || 'other',
        domainCategory: tuned.domainCategory || null,
        workload: tuned.workload || null,
        reason: tuned.reason || '',
        isMerchant: tuned.isMerchant,
        isManagerial: tuned.isManagerial,
      };

      evaluatedRecords.push(record);
    });
  }

  // оновлюємо seen
  projectsForAI.forEach((p) => seen.add(p.id));
  saveSeen(seen);

  // === 4.2. Сортуємо та зберігаємо результати ===

  evaluatedRecords.sort(sortByPriority);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // повний файл з усіма проєктами
  const outFileAll = path.join(
    __dirname,
    `results-${timestamp}.json`,
  );

  // окремий файл тільки з тими, що підходять (fit=true)
  const recommendedRecords = evaluatedRecords.filter((r) => r.fit);
  const outFileRecommended = path.join(
    __dirname,
    `results-recommended-${timestamp}.json`,
  );

  fs.writeFileSync(outFileAll, JSON.stringify(evaluatedRecords, null, 2), 'utf8');
  fs.writeFileSync(outFileRecommended, JSON.stringify(recommendedRecords, null, 2), 'utf8');

  // === 4.3. Розкладаємо по групах для красивого виводу ===

  const recommendedWithBudget = [];
  const recommendedNoBudget = [];
  const sitesFull = [];
  const lowPriorityCards = [];

  for (const rec of evaluatedRecords) {
    if (!rec.fit) {
      if (rec.category === 'low_priority_cards') {
        lowPriorityCards.push(rec);
      }
      continue;
    }

    if (rec.category === 'low_priority_cards') {
      lowPriorityCards.push(rec);
      continue;
    }
    if (rec.category === 'site_full') {
      sitesFull.push(rec);
      continue;
    }

    if (rec.budgetUAH != null) {
      recommendedWithBudget.push(rec);
    } else {
      recommendedNoBudget.push(rec);
    }
  }

  const sorter = sortByPriority;
  recommendedWithBudget.sort(sorter);
  recommendedNoBudget.sort(sorter);
  sitesFull.sort(sorter);
  lowPriorityCards.sort(sorter);

  // === 4.4. Вивід ===

  console.log('\n=== ФІДБЕК МОДЕЛІ ПО ВСІХ ПРОЄКТАХ, ЯКІ ДІЙШЛИ ДО AI ===\n');

  evaluatedRecords.forEach((r) => {
    console.log(`#id=${r.id}`);
    console.log(
      `[fit=${r.fit} | score=${r.finalScore}/10]${
        r.isMerchant ? ' [Merchant/Shopping ↑]' : r.isManagerial ? ' [Manager role ↓]' : ''
      }`,
    );
    console.log(
      `Категорія: ${r.category} | Домен: ${r.domainCategory || '-'} | Обсяг: ${r.workload || '-'}`,
    );
    console.log(`Назва: ${r.title}`);
    console.log(`Бюджет: ${r.budgetStr}`);
    console.log(`Посилання: ${r.url}`);
    if (r.reason) console.log(`Причина: ${r.reason}`);
    console.log('---');
  });

  if (recommendedWithBudget.length) {
    console.log('\n=== РЕКОМЕНДОВАНІ ПРОЄКТИ З БЮДЖЕТОМ (основний пріоритет) ===\n');
    recommendedWithBudget.forEach((r) => {
      console.log(`[${r.finalScore}/10] ✅ ID: ${r.id}`);
      console.log(
        `Домен: ${r.domainCategory || '-'} | Workload: ${r.workload || '-'}`,
      );
      console.log(`Назва: ${r.title}`);
      console.log(`Бюджет: ${r.budgetStr}`);
      console.log(`Посилання: ${r.url}`);
      if (r.reason) console.log(`Причина: ${r.reason}`);
      console.log('---');
    });
  }

  if (recommendedNoBudget.length) {
    console.log(
      '\n=== РЕКОМЕНДОВАНІ ПРОЄКТИ БЕЗ ВКАЗАНОГО БЮДЖЕТУ (основний пріоритет) ===\n',
    );
    recommendedNoBudget.forEach((r) => {
      console.log(`[${r.finalScore}/10] ✅ ID: ${r.id}`);
      console.log(
        `Домен: ${r.domainCategory || '-'} | Workload: ${r.workload || '-'}`,
      );
      console.log(`Назва: ${r.title}`);
      console.log(`Бюджет: ${r.budgetStr}`);
      console.log(`Посилання: ${r.url}`);
      if (r.reason) console.log(`Причина: ${r.reason}`);
      console.log('---');
    });
  }

  if (sitesFull.length) {
    console.log(
      '\n=== ОКРЕМО: САЙТИ / РОЗРОБКА ПІД КЛЮЧ (для роздумів) ===\n',
    );
    sitesFull.forEach((r) => {
      console.log(`[${r.finalScore}/10] 🧩 ID: ${r.id}`);
      console.log(
        `Домен: ${r.domainCategory || '-'} | Workload: ${r.workload || '-'}`,
      );
      console.log(`Назва: ${r.title}`);
      console.log(`Бюджет: ${r.budgetStr}`);
      console.log(`Посилання: ${r.url}`);
      if (r.reason) console.log(`Причина: ${r.reason}`);
      console.log('---');
    });
  }

  if (lowPriorityCards.length) {
    console.log(
      '\n=== НИЗЬКИЙ ПРІОРИТЕТ: НАПОВНЕННЯ / КАРТКИ ТОВАРІВ ===\n',
    );
    lowPriorityCards.forEach((r) => {
      console.log(`[${r.finalScore}/10] ⚠️ ID: ${r.id}`);
      console.log(
        `Домен: ${r.domainCategory || '-'} | Workload: ${r.workload || '-'}`,
      );
      console.log(`Назва: ${r.title}`);
      console.log(`Бюджет: ${r.budgetStr}`);
      console.log(`Посилання: ${r.url}`);
      if (r.reason) console.log(`Причина: ${r.reason}`);
      console.log('---');
    });
  }

  console.log(
    `\nРезультати (усі проєкти, відсортовані за пріоритетом) збережено у файлі: ${path.basename(
      outFileAll,
    )}`,
  );
  console.log(
    `Рекомендовані проєкти (fit=true) збережено у файлі: ${path.basename(
      outFileRecommended,
    )}`,
  );
}

main().catch((e) => {
  console.error('❌ Фатальна помилка:', e);
  process.exit(1);
});
