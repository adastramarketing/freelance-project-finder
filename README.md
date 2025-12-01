# freelance-project-finder

CLI-асистент для Анастасії (digital-маркетолога), який:

- тягне задачі з **Freelancehunt API**;
- фільтрує їх по статусу, бюджету, ключових словах;
- оцінює релевантність через **OpenAI** з підсиленням задач по  
  **Google Ads / Merchant Center / Shopping / PMax / GA4 / SEO / CRM / email / B2B**;
- зберігає:
  - повний список проєктів;
  - окремо — тільки рекомендовані (fit=true);
- на другому етапі готує:
  - **чернетки відповідей** на обрані проєкти;
  - **оцінку годин і вартості** (UA + Європа/США).

---

## 1. Вимоги

- **Node.js** 18+ (щоб був глобальний `fetch`).
- Аккаунт на:
  - [freelancehunt.com](https://freelancehunt.com)
  - [platform.openai.com](https://platform.openai.com)

---

## 2. Установка

```bash
git clone https://github.com/adastramarketing/freelance-project-finder.git
cd freelance-project-finder
npm install
