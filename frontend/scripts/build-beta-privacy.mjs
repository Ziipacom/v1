import { readFileSync, writeFileSync } from 'node:fs';

const notice = JSON.parse(readFileSync(new URL('../content/beta-privacy.json', import.meta.url), 'utf8'));
const output = new URL('../public/privacy-beta.html', import.meta.url);
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escape = (value) => value.replace(/[&<>"]/g, (character) => entities[character]);
const paragraphs = (section) => section.paragraphs.map((text) => `<p>${escape(text)}</p>`).join('\n');
const links = (section) => section.links
  ? `<ul>${section.links.map(({ url, label }) => `<li><a href="${escape(url)}">${escape(label)}</a></li>`).join('')}</ul>`
  : '';

// Cloudflare serves this exact path as an asset before running the SSR Worker.
// Keep the App Router page as a fallback for development and other hosts.
writeFileSync(output, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escape(notice.title)}</title>
  <style>
    html { color-scheme: dark; background: #151024; color: #f6f1fd; }
    body { max-width: 48rem; margin: 0 auto; padding: 1.5rem; font: 1rem/1.65 system-ui, sans-serif; }
    header, footer { display: flex; align-items: center; flex-wrap: wrap; gap: 1rem; }
    header img { display: block; width: 7rem; height: auto; }
    a { color: #dfcaff; }
    a:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
    h1, h2 { line-height: 1.25; }
    .eyebrow { color: #c4e865; margin-top: 2.5rem; }
    section { margin-block: 2rem; }
    footer { border-top: 1px solid #6b597f; padding-top: 1rem; }
  </style>
</head>
<body>
  <header><a href="/"><img src="/brand/ziipa-logo.png" alt="Ziipa home" width="9446" height="3104"></a><a href="/portal">Open Ziipa</a></header>
  <main>
    <article>
      <p class="eyebrow">BETA PRIVACY NOTICE · ${escape(notice.version)}</p>
      <h1>${escape(notice.title)}</h1>
      <p>${escape(notice.subtitle)}</p>
      <nav aria-label="Privacy notice sections"><ul>
        ${notice.sections.map(({ id, title }) => `<li><a href="#${escape(id)}">${escape(title)}</a></li>`).join('\n')}
      </ul></nav>
      ${notice.sections.map((section) => `<section id="${escape(section.id)}"><h2>${escape(section.title)}</h2>${paragraphs(section)}${links(section)}</section>`).join('\n')}
    </article>
  </main>
  <footer><a href="/">Back to Ziipa</a><a href="/account-deletion">Account deletion</a><a href="mailto:${escape(notice.support_and_privacy_email)}">Contact support</a></footer>
</body>
</html>
`, 'utf8');
