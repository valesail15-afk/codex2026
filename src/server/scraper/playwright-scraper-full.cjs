const { chromium } = require('playwright');

const LIVE_URL = 'https://live.500.com/';
const TRADE_URL = 'https://trade.500.com/jczq/';
const ASIA_ODDS_CACHE_TTL_MS = 10 * 60 * 1000;
const ASIA_ODDS_CONCURRENCY = 3;
const PLAYWRIGHT_CONTEXT_IDLE_CLOSE_MS = 8 * 60 * 1000;
const asiaOddsCache = new Map();
const asiaOddsInflight = new Map();
let persistentBrowser = null;
let persistentContext = null;
let contextInitPromise = null;
let contextIdleTimer = null;
let scrapeQueue = Promise.resolve();
const HANDICAP_TEXT_MAP = {
  '平手': '0',
  '半球': '0.5',
  '一球': '1',
  '球半': '1.5',
  '两球': '2',
  '两球半': '2.5',
  '平手/半球': '0/0.5',
  '半球/一球': '0.5/1',
  '一球/球半': '1/1.5',
  '球半/两球': '1.5/2',
  '两球/两球半': '2/2.5',
};

function normalizeAsianHandicapText(value) {
  if (!value || value === '-') return '-';

  const cleaned = String(value)
    .trim()
    .replace(/\s+/g, '')
    .replace(/[()（）]/g, '')
    .replace(/盘$/u, '')
    .replace(/盘口$/u, '')
    .replace(/[升降]$/u, '');

  let sign = '';
  let body = cleaned;

  if (body.startsWith('+') || body.startsWith('-')) {
    sign = body[0];
    body = body.slice(1);
  } else if (body.startsWith('受让')) {
    sign = '+';
    body = body.slice(2);
  } else if (body.startsWith('受')) {
    sign = '+';
    body = body.slice(1);
  } else if (body.startsWith('让')) {
    sign = '-';
    body = body.slice(1);
  } else {
    sign = '-';
  }

  const mapped = HANDICAP_TEXT_MAP[body] || body;
  if (!/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/.test(mapped)) return '-';
  return `${sign}${mapped}`;
}

function scheduleContextClose() {
  if (contextIdleTimer) clearTimeout(contextIdleTimer);
  contextIdleTimer = setTimeout(() => {
    closePersistentContext().catch(() => {});
  }, PLAYWRIGHT_CONTEXT_IDLE_CLOSE_MS);
}

async function closePersistentContext() {
  if (contextIdleTimer) {
    clearTimeout(contextIdleTimer);
    contextIdleTimer = null;
  }
  if (persistentContext) {
    try {
      await persistentContext.close();
    } catch {}
    persistentContext = null;
  }
  if (persistentBrowser) {
    try {
      await persistentBrowser.close();
    } catch {}
    persistentBrowser = null;
  }
}

async function getPersistentContext(forceRefresh = false) {
  if (forceRefresh) {
    await closePersistentContext();
  }
  if (persistentContext && persistentBrowser && persistentBrowser.isConnected()) {
    scheduleContextClose();
    return persistentContext;
  }
  if (contextInitPromise) {
    const ctx = await contextInitPromise;
    scheduleContextClose();
    return ctx;
  }
  contextInitPromise = (async () => {
    persistentBrowser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
    persistentContext = await persistentBrowser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    return persistentContext;
  })().finally(() => {
    contextInitPromise = null;
  });
  const context = await contextInitPromise;
  scheduleContextClose();
  return context;
}

async function runScrapeExclusive(task) {
  const chained = scrapeQueue.then(task, task);
  scrapeQueue = chained.catch(() => {});
  return chained;
}

async function scrapeFullMatchData(targetDate = null) {
  return runScrapeExclusive(async () => {
    const execute = async (forceRefresh = false) => {
      const context = await getPersistentContext(forceRefresh);
      const livePhase = await scrapeFromLive500(context, targetDate);
      if (livePhase.matches.length === 0) {
        return [];
      }
      const tradeMatches = await scrapeFromTrade500(context, livePhase.matches);
      return mergeMatchData(livePhase.matches, tradeMatches);
    };

    try {
      return await execute(false);
    } catch (err) {
      const errText = String(err?.message || err || '').toLowerCase();
      const shouldRetryFresh =
        errText.includes('has been closed') ||
        errText.includes('target page, context or browser has been closed') ||
        errText.includes('browser closed') ||
        errText.includes('context closed');
      if (!shouldRetryFresh) throw err;
      try {
        return await execute(true);
      } catch (retryErr) {
        throw retryErr;
      }
    }
  });
}

async function scrapeFromLive500(context, targetDate = null) {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);

  try {
    await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('table#table_match', { timeout: 30000 });

    await selectLatestDate(page, targetDate);
    await selectCrownOdds(page);

    const liveMatches = await collectLiveRows(page);
    return {
      matches: liveMatches.filter((match) => isNotStartedStatus(match.status)),
    };
  } finally {
    await page.close();
  }
}

async function scrapeFromTrade500(context, liveMatches) {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);

  try {
    await page.goto(TRADE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForTradePage(page);
    await closeHiddenMatches(page);
    await selectCrownAsia(page);

    const tradeRows = await collectTradeRows(page);
    const matchedRows = matchTradeRowsWithLiveRows(tradeRows, liveMatches);
    await enrichTradeRowsWithAsianOdds(context, matchedRows);
    return matchedRows;
  } catch {
    return [];
  } finally {
    await page.close();
  }
}

async function scrape365RichCrownData(targetDate = null) {
  return runScrapeExclusive(async () => {
    const context = await getPersistentContext(false);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);
    try {
      await page.goto('https://m.365rich.cn/Schedule.htm', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('#todaySchedule', { timeout: 30000 });
      await page.waitForTimeout(1800);

      const resolvedDate = await page.evaluate(async (payload) => {
        const wanted = typeof payload?.targetDate === 'string' ? payload.targetDate.trim() : '';
        const dateNodes = Array.from(document.querySelectorAll('#ul_Date [id^="li_"]'));
        const list = dateNodes
          .map((node) => {
            const id = String(node?.id || '');
            const onclick = String(node?.getAttribute('onclick') || '');
            const byId = id.match(/^li_(\d{4}-\d{2}-\d{2})$/)?.[1] || '';
            const byClick = onclick.match(/changeDate\('(\d{4}-\d{2}-\d{2})'\)/)?.[1] || '';
            const date = byId || byClick;
            return { node, date };
          })
          .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date));
        if (list.length === 0) return '';

        const activeNode =
          list.find((x) => String(x.node.className || '').includes('active') || String(x.node.className || '').includes('current')) ||
          list.find((x) => x.node.getAttribute('style')?.includes('active')) ||
          list[0];
        const picked = list.find((x) => x.date === wanted) || activeNode;
        const selectedDate = picked?.date || '';

        if (
          selectedDate &&
          wanted &&
          selectedDate === wanted &&
          typeof window.changeDate === 'function'
        ) {
          window.changeDate(wanted);
          await new Promise((resolve) => setTimeout(resolve, 1200));
        } else if (selectedDate && wanted && selectedDate !== wanted && typeof window.changeDate === 'function') {
          window.changeDate(wanted);
          await new Promise((resolve) => setTimeout(resolve, 1800));
          return wanted;
        }
        return selectedDate;
      }, { targetDate: targetDate || '' });

      await page.waitForTimeout(1200);
      const rows = await page.evaluate((payload) => {
        function toNum(v) {
          const n = Number.parseFloat(String(v || '').replace(/[^\d.+-]/g, ''));
          return Number.isFinite(n) ? n : 0;
        }
        function parseHandicapLine(text) {
          const line = String(text || '').trim();
          if (!line || line === '-' || /赢|输|走/i.test(line)) return '';
          return line;
        }
        function getDateForRow(defaultDate) {
          const current = document.querySelector('#ul_Date [class*="active"], #ul_Date [class*="current"]');
          const idDate = String(current?.id || '').match(/^li_(\d{4}-\d{2}-\d{2})$/)?.[1] || '';
          if (idDate) return idDate;
          return defaultDate;
        }
        const out = [];
        const selectedDate = String(payload?.sourceDate || '').trim();
        const rowDate = getDateForRow(selectedDate);
        const items = Array.from(document.querySelectorAll('#todaySchedule > li'));
        for (const node of items) {
          const onclick = String(node.getAttribute('onclick') || '');
          const idText = onclick.match(/toFenXi\((\d+)\)/)?.[1] || '';
          if (!/^\d+$/.test(idText)) continue;
          const matchId = Number.parseInt(idText, 10);
          if (!Number.isFinite(matchId) || matchId <= 0) continue;
          const mt = node.querySelector('.game .time')?.textContent?.trim() || '';
          const gameText = node.querySelector('.game')?.textContent?.replace(/\s+/g, ' ').trim() || '';
          const league = gameText.replace(mt, '').trim();
          const home = node.querySelector(`#hname_${matchId}`)?.textContent?.trim() || '';
          const away = node.querySelector(`#gname_${matchId}`)?.textContent?.trim() || '';
          const oddsSpans = Array.from(node.querySelectorAll('.odds span')).map((x) => (x.textContent || '').trim());
          const hLine = parseHandicapLine(oddsSpans[0] || '');
          const hOdds = toNum(node.querySelector(`#hOdds_${matchId}`)?.textContent);
          const aOdds = toNum(node.querySelector(`#aOdds_${matchId}`)?.textContent);
          const oOdds = toNum(node.querySelector(`#oOdds_${matchId}`)?.textContent);
          const ouLine = String(node.querySelector(`#ogoal_${matchId}`)?.textContent || '').trim();
          const uOdds = toNum(node.querySelector(`#uOdds_${matchId}`)?.textContent);
          out.push({
            sourceMatchId: String(matchId),
            sourceDate: rowDate || selectedDate || '',
            matchTime: mt,
            league,
            homeTeam: home,
            awayTeam: away,
            handicap: { line: hLine, homeOdds: hOdds, awayOdds: aOdds },
            overUnder: { line: ouLine, overOdds: oOdds, underOdds: uOdds },
          });
        }
        return out;
      }, { sourceDate: resolvedDate || String(targetDate || '') });
      return Array.isArray(rows) ? rows : [];
    } finally {
      await page.close();
    }
  });
}

function parse365DetailOddsRows(rawRows) {
  const output = [];
  for (const row of Array.isArray(rawRows) ? rawRows : []) {
    const line = String(row?.line || '').trim();
    const homeOdds = Number(row?.homeOdds || 0);
    const awayOdds = Number(row?.awayOdds || 0);
    if (!line || line === '-') continue;
    if (!Number.isFinite(homeOdds) || !Number.isFinite(awayOdds)) continue;
    if (homeOdds <= 0 || awayOdds <= 0) continue;
    output.push({ line, homeOdds, awayOdds });
  }
  return output;
}

async function scrape365RichCrownDetails(matchIds = []) {
  return runScrapeExclusive(async () => {
    const ids = Array.from(
      new Set(
        (Array.isArray(matchIds) ? matchIds : [])
          .map((id) => String(id || '').trim())
          .filter((id) => /^\d+$/.test(id))
      )
    );
    if (ids.length === 0) return {};

    const context = await getPersistentContext(false);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);

    async function parsePageRows(url, oddsType) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1800);
      const rows = await page.evaluate((payload) => {
        const targetType = Number(payload?.oddsType || 0);
        function toNum(v) {
          const n = Number.parseFloat(String(v || '').replace(/[^\d.+-]/g, ''));
          return Number.isFinite(n) ? n : 0;
        }
        function parseCompanyId(onclickText) {
          const text = String(onclickText || '');
          let m = text.match(/ShowMainOddsDetail\(\s*\d+\s*,\s*(\d+)\s*,/i);
          if (m) return Number.parseInt(m[1], 10);
          m = text.match(/ShowOddsDetail\(\s*\d+\s*,\s*\d+\s*,\s*this\s*,\s*\d+\s*,\s*(\d+)\s*\)/i);
          if (m) return Number.parseInt(m[1], 10);
          return NaN;
        }
        function parseOddsType(onclickText) {
          const text = String(onclickText || '');
          const m = text.match(/Show(?:Main)?OddsDetail\(\s*(\d+)\s*,/i);
          if (!m) return NaN;
          return Number.parseInt(m[1], 10);
        }
        const blocks = Array.from(document.querySelectorAll('#oddsData > div'));
        const out = [];
        for (const block of blocks) {
          const cid = Number.parseInt(String(block.getAttribute('data-cid') || ''), 10);
          const onclick = String(block.getAttribute('onclick') || '');
          const companyId = Number.isFinite(cid) ? cid : parseCompanyId(onclick);
          if (companyId !== 3) continue;
          const type = parseOddsType(onclick);
          if (!Number.isFinite(type) || type !== targetType) continue;
          const groups = Array.from(block.querySelectorAll('.oddsdata')).map((box) =>
            Array.from(box.querySelectorAll('span')).map((span) => (span.textContent || '').trim())
          );
          if (groups.length === 0) continue;
          const current = groups[1] || groups[0] || [];
          const initial = groups[0] || [];
          const line = String(current[1] || initial[1] || '').trim();
          const homeOdds = toNum(current[0] || initial[0] || '');
          const awayOdds = toNum(current[2] || initial[2] || '');
          out.push({ line, homeOdds, awayOdds });
        }
        return out;
      }, { oddsType });
      return parse365DetailOddsRows(rows);
    }

    try {
      const detailMap = {};
      for (const matchId of ids) {
        const asianRows = await parsePageRows(`https://m.365rich.cn/asian/${matchId}.htm`, 0).catch(() => []);
        const ouRows = await parsePageRows(`https://m.365rich.cn/overunder/${matchId}.htm`, 1).catch(() => []);
        detailMap[matchId] = {
          handicaps: asianRows.map((row) => ({
            type: String(row.line || '').trim(),
            home_odds: Number(row.homeOdds || 0),
            away_odds: Number(row.awayOdds || 0),
          })),
          overUnderOdds: ouRows.map((row) => ({
            line: String(row.line || '').trim(),
            over_odds: Number(row.homeOdds || 0),
            under_odds: Number(row.awayOdds || 0),
          })),
        };
      }
      return detailMap;
    } finally {
      await page.close();
    }
  });
}

async function waitForTradePage(page) {
  const selectors = ['.bet-tb', 'table'];
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: 15000 });
      await page.waitForTimeout(2000);
      return;
    } catch {}
  }
  throw new Error('trade page table not found');
}

async function selectLatestDate(page, preferredDate = null) {
  await page.waitForSelector('#sel_expect', { timeout: 10000 });

  const options = await page.evaluate(() => {
    const select = document.querySelector('#sel_expect');
    if (!select) return [];
    return Array.from(select.querySelectorAll('option')).map((option) => ({
      value: option.value,
      label: option.textContent.trim(),
    }));
  });

  if (options.length === 0) {
    throw new Error('date options not found');
  }

  let selected = options[0];
  if (preferredDate) {
    const matched = options.find(
      (option) => option.value.includes(preferredDate) || option.label.includes(preferredDate)
    );
    if (matched) {
      selected = matched;
    }
  }

  await page.selectOption('#sel_expect', selected.value);
  await page.waitForTimeout(3000);
  await page.waitForSelector('table#table_match tbody tr', { timeout: 10000 });
}

async function selectCrownOdds(page) {
  await page.waitForSelector('#sel_odds', { timeout: 10000 });

  const options = await page.evaluate(() => {
    const select = document.querySelector('#sel_odds');
    if (!select) return [];
    return Array.from(select.querySelectorAll('option')).map((option) => ({
      value: option.value,
      label: option.textContent.trim(),
    }));
  });

  const crownLabelPattern = new RegExp('\\u7687\\u51A0|crown', 'i');
  const crownOption = options.find((option) => option.value === '280' || crownLabelPattern.test(option.label));
  if (!crownOption) {
    throw new Error('crown odds option not found');
  }

  await page.selectOption('#sel_odds', crownOption.value);
  await page.waitForTimeout(3000);
}

async function closeHiddenMatches(page) {
  const candidates = [
    'text=/\\u5DF2\\u9690\\u85CF|\\u9690\\u85CF/',
    'text=/\\u663E\\u793A/',
    'text=/\\u5C55\\u5F00/',
    'text=/\\u66F4\\u591A/',
  ];
  for (const selector of candidates) {
    const locators = await page.locator(selector).all();
    for (const locator of locators.slice(0, 5)) {
      try {
        await locator.click({ timeout: 1000 });
        await page.waitForTimeout(300);
      } catch {}
    }
  }
}

async function selectCrownAsia(page) {
  try {
    const averageTrigger = page
      .locator('text=/\\u767E\\u5BB6\\u5E73\\u5747|\\u5E73\\u5747|Average/i')
      .first();
    if (await averageTrigger.count()) {
      await averageTrigger.click({ timeout: 1500 });
      await page.waitForTimeout(800);
    }
  } catch {}

  try {
    const crownAsiaOption = page
      .locator('text=/\\u7687\\u51A0\\u4E9A\\u76D8|\\u4E9A\\u76D8|Crown/i')
      .first();
    if (await crownAsiaOption.count()) {
      await crownAsiaOption.click({ timeout: 1500 });
      await page.waitForTimeout(2000);
      return true;
    }
  } catch {}

  try {
    const selectLocator = page.locator('select').first();
    if (await selectLocator.count()) {
      const options = await selectLocator.locator('option').allTextContents();
      const crownAsiaPattern = new RegExp('\\u7687\\u51A0\\u4E9A\\u76D8|\\u4E9A\\u76D8|Crown', 'i');
      const index = options.findIndex((text) => crownAsiaPattern.test(text || ''));
      if (index >= 0) {
        const value = await selectLocator.locator('option').nth(index).getAttribute('value');
        if (value) {
          await selectLocator.selectOption(value);
          await page.waitForTimeout(2000);
          return true;
        }
      }
    }
  } catch {}

  return false;
}

async function collectLiveRows(page) {
  const rows = await page.evaluate(() => {
    const tableRows = Array.from(document.querySelectorAll('table#table_match tbody tr'));

    const extractText = (cell) => (cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '');
    const extractOdds = (text) => {
      const values = text.match(/\d{1,2}\.\d{2}/g) || [];
      return {
        win: values[0] || '-',
        draw: values[1] || '-',
        lose: values[2] || '-',
      };
    };

    return tableRows
      .map((row) => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 10) return null;

        const homeText = extractText(cells[5]);
        const awayText = extractText(cells[7]);
        const crownText = [extractText(cells[9]), extractText(cells[10]), extractText(cells[11])].join(' ');

        return {
          id: (row.id || '').replace(/^a/, ''),
          league: extractText(cells[1]),
          round: extractText(cells[2]),
          matchTime: extractText(cells[3]),
          status: extractText(cells[4]),
          homeText,
          awayText,
          score: extractText(cells[8]) || 'VS',
          crownOdds: extractOdds(crownText),
        };
      })
      .filter(Boolean);
  });

  return rows.map(normalizeLiveRow).filter((row) => row.id || row.homeTeam || row.awayTeam);
}

function normalizeLiveRow(row) {
  const homeRank = extractBracketValue(row.homeText);
  const awayRank = extractBracketValue(row.awayText);
  const handicap = extractParenthesisValue(row.homeText) || extractParenthesisValue(row.awayText) || '';

  return {
    id: row.id,
    league: row.league,
    round: row.round,
    matchTime: row.matchTime,
    status: row.status,
    homeTeam: stripTeamDecorators(row.homeText),
    homeRank,
    awayTeam: stripTeamDecorators(row.awayText),
    awayRank,
    handicap,
    score: row.score === '-' ? 'VS' : row.score,
    crownOdds: normalizeOdds(row.crownOdds),
  };
}

async function collectTradeRows(page) {
  return page.evaluate(() => {
    const extractText = (cell) => (cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '');
    const rows = Array.from(document.querySelectorAll('.bet-tb tr'));

    return rows
      .map((row) => {
        const linkCells = Array.from(row.querySelectorAll('td'));
        const cells = linkCells.map((cell) => ({
          text: extractText(cell),
          childTexts: Array.from(cell?.children || []).map((child) => extractText(child)).filter(Boolean),
        }));
        const analysisLinks = linkCells[6]
          ? Array.from(linkCells[6].querySelectorAll('a')).map((anchor) => ({
              text: (anchor.textContent || '').trim(),
              href: anchor.href,
            }))
          : [];

        return { cells, analysisLinks };
      })
      .filter((row) => row.cells.length >= 6);
  });
}

function matchTradeRowsWithLiveRows(tradeRows, liveMatches) {
  return tradeRows
    .map((row) => normalizeTradeRow(row))
    .filter((row) => row.homeTeam || row.awayTeam)
    .map((tradeRow) => {
      const liveMatch = findBestLiveMatch(tradeRow, liveMatches);
      if (!liveMatch) return null;

      return {
        id: liveMatch.id,
        regularHandicap: tradeRow.regularHandicap || '0',
        jingcaiHandicap: tradeRow.jingcaiHandicap || tradeRow.regularHandicap || '-',
        jingcaiOdds: tradeRow.jingcaiOdds,
        jingcaiHandicapOdds: tradeRow.jingcaiHandicapOdds,
        crownAsia: tradeRow.crownAsia,
        analysisLinks: tradeRow.analysisLinks,
      };
    })
    .filter(Boolean);
}
function normalizeTradeRow(row) {
  const cells = row.cells;
  const teamsText = getTradeCellText(cells[3]);
  const handicapText = getTradeCellText(cells[4]);
  const handicapChildTexts = Array.isArray(cells[4]?.childTexts) ? cells[4].childTexts : [];
  const oddsCell = cells[5];
  const [homeText = '', awayText = ''] = teamsText.split(/\s+VS\s+/i);
  const { standardOdds, handicapOdds } = extractTradeOddsGroups(oddsCell);

  const childNums = handicapChildTexts
    .map((text) => (text || '').replace(/^\\u5355\\u5173/u, '').trim())
    .map((text) => text.match(/[+-]?\d+(?:\.\d+)?/g))
    .filter(Boolean)
    .map((arr) => arr[arr.length - 1]);

  const textNums = (handicapText.match(/[+-]?\d+(?:\.\d+)?/g) || []);
  const values = (childNums.length > 0 ? childNums : textNums).filter(Boolean);
  const regularHandicap = values[0] || '0';
  const jingcaiHandicap = values[1] || values[0] || '-';

  return {
    matchNo: getTradeCellText(cells[0]),
    homeTeam: stripTeamDecorators(homeText),
    awayTeam: stripTeamDecorators(awayText),
    regularHandicap,
    jingcaiHandicap,
    jingcaiOdds: standardOdds,
    jingcaiHandicapOdds: handicapOdds,
    crownAsia: { handicap: '-', homeWater: '-', awayWater: '-' },
    analysisLinks: row.analysisLinks || [],
    analysisMatchId: extractMatchIdFromLinks(row.analysisLinks || []),
  };
}
function getTradeCellText(cell) {
  if (!cell) return '';
  return typeof cell === 'string' ? cell : cell.text || '';
}

function extractTradeOddsGroups(cell) {
  const emptyOdds = { win: '-', draw: '-', lose: '-' };
  const cellText = getTradeCellText(cell);
  const childTexts = Array.isArray(cell?.childTexts) ? cell.childTexts : [];

  const triplets = childTexts
    .map((text) => (text.match(/\d{1,2}\.\d{2}/g) || []).slice(0, 3))
    .filter((values) => values.length === 3);

  if (triplets.length >= 2) {
    return {
      standardOdds: normalizeOdds({ win: triplets[0][0], draw: triplets[0][1], lose: triplets[0][2] }),
      handicapOdds: normalizeOdds({ win: triplets[1][0], draw: triplets[1][1], lose: triplets[1][2] }),
    };
  }

  const allOdds = cellText.match(/\d{1,2}\.\d{2}/g) || [];
  if (allOdds.length >= 6) {
    return {
      standardOdds: normalizeOdds({ win: allOdds[0], draw: allOdds[1], lose: allOdds[2] }),
      handicapOdds: normalizeOdds({ win: allOdds[3], draw: allOdds[4], lose: allOdds[5] }),
    };
  }

  if (allOdds.length >= 3) {
    return {
      standardOdds: normalizeOdds({ win: allOdds[0], draw: allOdds[1], lose: allOdds[2] }),
      handicapOdds: emptyOdds,
    };
  }

  return { standardOdds: emptyOdds, handicapOdds: emptyOdds };
}

async function enrichTradeRowsWithAsianOdds(context, matchedRows) {
  await mapWithConcurrency(matchedRows, ASIA_ODDS_CONCURRENCY, async (row) => {
    const asiaLink = row.analysisLinks?.find((item) => /\u4E9A\u76D8|\u4E9A|yapan|asia/i.test(item.text || ''))?.href;
    if (!asiaLink) return;

    try {
      const crownAsia = await fetchCrownAsiaOdds(context, asiaLink);
      if (crownAsia) {
        row.crownAsia = {
          handicap: crownAsia.handicap,
          homeWater: crownAsia.homeWater,
          awayWater: crownAsia.awayWater,
        };
        row.crownHandicaps = Array.isArray(crownAsia.crownHandicaps) ? crownAsia.crownHandicaps : [];
      }
    } catch {}
  });
}

async function fetchCrownAsiaOdds(context, url) {
  const cached = asiaOddsCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (asiaOddsInflight.has(url)) return asiaOddsInflight.get(url);

  const task = fetchCrownAsiaOddsUncached(context, url)
    .then((data) => {
      asiaOddsCache.set(url, { data, expiresAt: Date.now() + ASIA_ODDS_CACHE_TTL_MS });
      return data;
    })
    .finally(() => {
      asiaOddsInflight.delete(url);
    });

  asiaOddsInflight.set(url, task);
  return task;
}

async function fetchCrownAsiaOddsUncached(context, url) {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    return await page.evaluate(() => {
      const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim();
      const tables = Array.from(document.querySelectorAll('table.pub_table'));
      const dataTable = tables[1];
      if (!dataTable) return null;


      const rows = Array.from(dataTable.querySelectorAll('tr'));
      const parsed = rows
        .map((row) => Array.from(row.querySelectorAll('td')).map((td) => normalize(td.textContent)))
        .filter((cells) => cells.length >= 6)
        .map((cells) => ({
          company: cells[1] || '',
          homeWater: (cells[3] || '').replace(/[^0-9.]/g, '') || '-',
          handicap: normalize(cells[4] || '').trim() || '-',
          awayWater: (cells[5] || '').replace(/[^0-9.]/g, '') || '-',
        }))
        .filter((item) => item.handicap && item.handicap !== '-' && item.homeWater && item.awayWater);

      const crownRows = parsed.filter((item) => /\u7687\u51A0|crown/i.test(item.company));
      if (crownRows.length > 0) {
        const crownHandicaps = crownRows
          .map((item) => ({
            type: normalizeAsianHandicapText(item.handicap),
            home_odds: Number((item.homeWater || '').replace(/[^0-9.]/g, '')) || 0,
            away_odds: Number((item.awayWater || '').replace(/[^0-9.]/g, '')) || 0,
          }))
          .filter((item) => item.type && item.type !== '-' && item.home_odds > 0 && item.away_odds > 0);
        const crownRow = crownRows[0];
        return {
          homeWater: crownRow.homeWater,
          handicap: normalizeAsianHandicapText(crownRow.handicap),
          awayWater: crownRow.awayWater,
          crownHandicaps,
        };
      }

      const firstRow = parsed[0];
      if (firstRow) {
        return {
          homeWater: firstRow.homeWater,
          handicap: normalizeAsianHandicapText(firstRow.handicap),
          awayWater: firstRow.awayWater,
          crownHandicaps: [
            {
              type: normalizeAsianHandicapText(firstRow.handicap),
              home_odds: Number((firstRow.homeWater || '').replace(/[^0-9.]/g, '')) || 0,
              away_odds: Number((firstRow.awayWater || '').replace(/[^0-9.]/g, '')) || 0,
            },
          ].filter((item) => item.type && item.type !== '-' && item.home_odds > 0 && item.away_odds > 0),
        };
      }

      return null;
    });
  } finally {
    await page.close();
  }
}
function findBestLiveMatch(tradeRow, liveMatches) {
  if (tradeRow.analysisMatchId) {
    const matchedById = liveMatches.find((liveMatch) => liveMatch.id === tradeRow.analysisMatchId);
    if (matchedById) return matchedById;
  }

  const normalizedTradeHome = normalizeTeamKey(tradeRow.homeTeam);
  const normalizedTradeAway = normalizeTeamKey(tradeRow.awayTeam);
  const tradeTime = normalizeMatchTime(tradeRow.matchTime);

  let matched = liveMatches.find(
    (liveMatch) =>
      normalizeTeamKey(liveMatch.homeTeam) === normalizedTradeHome &&
      normalizeTeamKey(liveMatch.awayTeam) === normalizedTradeAway &&
      normalizeMatchTime(liveMatch.matchTime) === tradeTime
  );
  if (matched) return matched;

  matched = liveMatches.find(
    (liveMatch) =>
      normalizeTeamKey(liveMatch.homeTeam) === normalizedTradeHome &&
      normalizeTeamKey(liveMatch.awayTeam) === normalizedTradeAway
  );
  if (matched) return matched;

  const suffixMatch = (tradeRow.matchNo || '').match(/(\d{3})$/);
  if (!suffixMatch) return null;
  const suffix = suffixMatch[1];
  return liveMatches.find((liveMatch) => (liveMatch.id || '').endsWith(suffix)) || null;
}

function mergeMatchData(liveData, tradeData) {
  return liveData.map((liveMatch) => {
    const tradeMatch = tradeData.find((item) => item.id === liveMatch.id);
    return {
      ...liveMatch,
      handicap: tradeMatch?.regularHandicap || liveMatch.handicap || '0',
      jingcaiHandicap: tradeMatch?.jingcaiHandicap || '-',
      jingcaiOdds: tradeMatch?.jingcaiOdds || { win: '-', draw: '-', lose: '-' },
      jingcaiHandicapOdds: tradeMatch?.jingcaiHandicapOdds || { win: '-', draw: '-', lose: '-' },
      crownAsia: tradeMatch?.crownAsia || { handicap: '-', homeWater: '-', awayWater: '-' },
      crownHandicaps: tradeMatch?.crownHandicaps || [],
    };
  });
}
function normalizeOdds(odds) {
  return {
    win: odds?.win || '-',
    draw: odds?.draw || '-',
    lose: odds?.lose || '-',
  };
}

function stripTeamDecorators(text) {
  return (text || '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBracketValue(text) {
  const match = (text || '').match(/\[([^\]]+)\]/);
  return match ? match[1].trim() : '';
}

function extractParenthesisValue(text) {
  const match = (text || '').match(/\(([^)]*)\)/);
  return match ? match[1].trim() : '';
}

function normalizeTeamKey(text) {
  return stripTeamDecorators(text).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function normalizeMatchTime(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function extractMatchIdFromLinks(links) {
  for (const link of links) {
    const match = (link.href || '').match(/-(\d+)\.shtml/);
    if (match) return match[1];
  }
  return '';
}

async function mapWithConcurrency(items, concurrency, worker) {
  let index = 0;

  async function runWorker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    () => runWorker()
  );

  await Promise.all(workers);
}

async function fetchRawTextViaBrowser(url) {
  return runScrapeExclusive(async () => {
    const context = await getPersistentContext(false);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);
    try {
      const resp = await page.goto(String(url || ''), { waitUntil: 'domcontentloaded', timeout: 60000 });
      const status = resp ? resp.status() : 0;
      if (status >= 400) {
        throw new Error(`browser request failed: ${status}`);
      }
      const text = await page.evaluate(() => {
        const pre = document.querySelector('pre');
        if (pre && pre.textContent) return pre.textContent;
        const body = document.body;
        return body ? body.innerText || body.textContent || '' : '';
      });
      return String(text || '').trim();
    } finally {
      await page.close();
    }
  });
}

function isNotStartedStatus(status) {
  const text = (status || '').replace(/\s+/g, '').trim();
  if (!text) return false;
  if (
    text.includes('\u6539\u671F') ||
    text.includes('\u5EF6\u671F') ||
    text.includes('\u53D6\u6D88') ||
    text.includes('\u5B8C')
  ) {
    return false;
  }
  return text.includes('\u672A');
}

module.exports = {
  scrapeFullMatchData,
  scrape365RichCrownData,
  scrape365RichCrownDetails,
  fetchRawTextViaBrowser,
};
