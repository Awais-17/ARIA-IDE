/**
 * browserManager.js
 * ----------------------------------------------------------------------------
 * Real browser automation for ARIA's agentic tool-use loop (the
 * kimi-webbridge-equivalent `browser_action` tool).
 *
 * Uses playwright-core (no bundled Chromium download) launched with
 * `channel: 'chrome'` so it drives the user's already-installed Google
 * Chrome. One shared page is lazily launched on first use and kept alive
 * across tool calls within an agent run; `close` (or app exit) tears it down.
 * ----------------------------------------------------------------------------
 */
const MAX_TEXT = 20000;

let browser = null;
let page = null;
let launchPromise = null;

function truncate(str) {
    if (str.length <= MAX_TEXT) return str;
    return str.slice(0, MAX_TEXT) + `\n\n… [truncated ${str.length - MAX_TEXT} more chars]`;
}

async function getPage() {
    if (page && !page.isClosed()) return page;
    if (!launchPromise) {
        launchPromise = (async () => {
            const { chromium } = require('playwright-core');
            try {
                browser = await chromium.launch({ channel: 'chrome', headless: false });
            } catch (e) {
                launchPromise = null;
                throw new Error(`Could not launch Chrome for browser automation — is Google Chrome installed? (${e.message})`);
            }
            browser.on('disconnected', () => { browser = null; page = null; launchPromise = null; });
            const context = await browser.newContext();
            page = await context.newPage();
            return page;
        })();
    }
    return launchPromise;
}

async function closeBrowser() {
    const b = browser;
    browser = null;
    page = null;
    launchPromise = null;
    if (b) {
        try { await b.close(); } catch { /* best-effort */ }
    }
}

/** Executes one browser_action tool call. Returns { ok, content, meta? }. */
async function runBrowserAction(args = {}) {
    const { type } = args;
    try {
        if (type === 'close') {
            await closeBrowser();
            return { ok: true, content: 'Browser closed.' };
        }

        const p = await getPage();

        switch (type) {
            case 'navigate': {
                if (!args.url) return { ok: false, content: 'navigate requires a "url".' };
                await p.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                const title = await p.title();
                return { ok: true, content: `Navigated to ${p.url()}\nTitle: ${title}` };
            }

            case 'read': {
                const text = await p.evaluate(() => document.body?.innerText || '');
                return { ok: true, content: truncate(text) || '(empty page)' };
            }

            case 'click': {
                if (!args.selector) return { ok: false, content: 'click requires a "selector".' };
                await p.click(args.selector, { timeout: 10000 });
                return { ok: true, content: `Clicked "${args.selector}".` };
            }

            case 'type': {
                if (!args.selector) return { ok: false, content: 'type requires a "selector".' };
                await p.fill(args.selector, args.text || '');
                return { ok: true, content: `Typed into "${args.selector}".` };
            }

            case 'list_elements': {
                const elements = await p.evaluate(() => {
                    const nodes = Array.from(document.querySelectorAll('a, button, input, textarea, select, [role="button"]'));
                    return nodes.slice(0, 100).map(el => ({
                        tag: el.tagName.toLowerCase(),
                        text: (el.innerText || el.value || el.placeholder || '').trim().slice(0, 80),
                        selector: el.id ? `#${el.id}` : (el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : el.tagName.toLowerCase()),
                    }));
                });
                return { ok: true, content: JSON.stringify(elements, null, 2) };
            }

            case 'screenshot': {
                const buf = await p.screenshot({ type: 'png' });
                return { ok: true, content: `Screenshot captured (${buf.length} bytes) of ${p.url()}.`, meta: { screenshot: buf.toString('base64') } };
            }

            default:
                return { ok: false, content: `Unknown browser action type: "${type}". Use navigate | read | click | type | list_elements | screenshot | close.` };
        }
    } catch (e) {
        return { ok: false, content: `Browser action "${type}" failed: ${e.message}` };
    }
}

module.exports = { runBrowserAction, closeBrowser };
