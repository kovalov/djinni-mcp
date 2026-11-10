// Captures sanitized HTML fixtures from djinni.co for parser tests.
//
// After every capture, run `node scripts/sanitize-fixtures.mjs`. This script
// does not remove the CSRF tokens, the emails, the CV links and the token
// query values. The sanitizer removes them.
//
// Run it with playwright-cli in a browser session that is logged in to a
// candidate account:
//   playwright-cli -s=djinni run-code --filename=scripts/capture-fixtures.js
//
// The script sends GET requests only. It does not open inbox threads,
// because a GET on a thread can mark the thread as read.
// The script removes personal data before it returns the HTML:
// names, phones, contact links, free text in the user's own forms and the
// candidate ID.
async page => {
  const BASE = 'https://djinni.co';
  const fixtures = {};

  const scrub = html => {
    // scripts/sanitize-fixtures.mjs removes the emails, the CSRF tokens,
    // the CV links and the token query values.
    return html
      .replace(/\+?\d[\d ()-]{9,}\d/g, '+380000000000')
      .replace(/https?:\/\/(www\.)?linkedin\.com\/in\/[^"'\s<]+/g, 'https://www.linkedin.com/in/example')
      .replace(/https?:\/\/(www\.)?github\.com\/[^"'\s</]+/g, 'https://github.com/example');
  };

  // Redacts the values of the user's own form fields in the live DOM.
  const redactOwnForms = async () => {
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('input[type=text], input[type=email], input[type=tel], input[type=url], input:not([type])')) {
        if (el.name && el.value) el.setAttribute('value', 'REDACTED_' + el.name);
      }
      for (const el of document.querySelectorAll('textarea')) {
        if (el.name) el.textContent = 'REDACTED_' + el.name;
      }
      for (const el of document.querySelectorAll('img[src*="userpic"], img[src*="avatar"]')) el.setAttribute('src', '/static/placeholder.png');
    });
  };

  // Replaces every visible text node inside the selector with a numbered placeholder.
  const redactText = async selector => {
    await page.evaluate(sel => {
      let n = 0;
      for (const root of document.querySelectorAll(sel)) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const t of nodes) if (t.textContent.trim()) t.textContent = 'TEXT_' + (++n);
      }
    }, selector);
  };

  const grab = async (name, path, opts = {}) => {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    if (opts.ownForms) await redactOwnForms();
    if (opts.redactText) await redactText(opts.redactText);
    fixtures[name] = await page.content();
  };

  const fragment = async (name, path) => {
    const r = await page.request.get(BASE + path, { headers: { 'HX-Request': 'true' } });
    fixtures[name] = await r.text();
  };

  // Learn the identifiers that must be replaced everywhere.
  await page.goto(BASE + '/my/account/', { waitUntil: 'domcontentloaded' });
  const secrets = await page.evaluate(() => {
    const out = [];
    for (const n of ['name', 'telegram', 'whatsapp', 'github', 'portfolio', 'linkedin']) {
      const el = document.querySelector(`[name="${n}"]`);
      if (el && el.value && el.value.length > 2) out.push(el.value);
    }
    // The account page links to the user's own public profile /q/<hash>/.
    const own = document.querySelector('a[href^="/q/"]');
    if (own) out.push(own.getAttribute('href').split('/')[2]);
    return out;
  });
  await page.goto(BASE + '/jobs/?primary_keyword=Python', { waitUntil: 'domcontentloaded' });
  const jobLinks = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href^="/jobs/"]')].map(a => a.getAttribute('href').split('?')[0]).filter(h => /^\/jobs\/\d+-/.test(h)))]);
  fixtures['jobs_list'] = await page.content();

  const jobPath = jobLinks[0];
  await grab('job_detail', jobPath);
  const jobId = jobPath.match(/\/jobs\/(\d+)/)[1];
  const meta = await page.evaluate(() => {
    const b = document.querySelector('[data-candidate-id]');
    const company = [...document.querySelectorAll('a[href^="/jobs/company-"]')].map(a => a.getAttribute('href').split('?')[0])[0];
    return { candidateId: b && b.getAttribute('data-candidate-id'), company };
  });
  await fragment('job_apply_stats', `/api/jobs/${jobId}/?apply_stats&candidate_id=${meta.candidateId}`);
  await fragment('job_similar', `/jobs/${jobId}/similar-jobs/`);
  if (meta.company) await grab('company', meta.company);

  const rss = await page.request.get(BASE + '/jobs/rss/?primary_keyword=Python');
  fixtures['jobs_rss'] = await rss.text();

  await grab('developers_list', '/developers/?keywords=python');
  const qPath = await page.evaluate(() => [...document.querySelectorAll('a[href^="/q/"]')].map(a => a.getAttribute('href').split('?')[0])[0]);
  await grab('candidate_profile', qPath);
  const qHash = qPath.match(/\/q\/([^/]+)/)[1];
  await fragment('candidate_similar', `/similar-candidates/q/${qHash}/`);

  await grab('my_profile', '/my/profile/', { ownForms: true });
  await grab('my_account', '/my/account/', { ownForms: true });
  await grab('my_resume', '/my/resume/', { redactText: 'main table, main .list-group, main ul' });
  await grab('my_dashboard', '/my/dashboard/');
  await grab('my_subscriptions', '/my/subscriptions/');
  await grab('my_inbox', '/my/inbox/', { redactText: '#inbox_page' });
  await fragment('subscription_form', '/ajax/jobs_subs/form_modal?referral=my_subs&redirect=1&feature=dashboard2');
  await fragment('cv_input', '/ajax/cv_input/?remove_on_cancel=true');

  const out = {};
  for (const [k, v] of Object.entries(fixtures)) {
    let s = scrub(v);
    for (const secret of secrets) {
      // The name also appears in CV file names, in upper case and with underscores.
      const variants = new Set([secret, secret.toUpperCase(), secret.replace(/\s+/g, '_'), secret.toUpperCase().replace(/\s+/g, '_')]);
      for (const part of secret.split(/\s+/)) if (part.length > 3) { variants.add(part); variants.add(part.toUpperCase()); }
      for (const v of variants) s = s.split(v).join('REDACTED');
    }
    if (meta.candidateId) s = s.split(meta.candidateId).join('100001');
    out[k] = s;
  }
  return JSON.stringify({ meta: { jobPath, company: meta.company, qPath }, fixtures: out });
}
