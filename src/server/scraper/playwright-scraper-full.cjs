const { chromium } = require('playwright');

const LIVE_URL = 'https://live.500.com/';
const TRADE_URL = 'https://trade.500.com/jczq/';
const ASIA_ODDS_CACHE_TTL_MS = 10 * 60 * 1000;
const ASIA_ODDS_CONCURRENCY = 3;
const asiaOddsCache = new Map();
const asiaOddsInflight = new Map();

async function scrapeFullMatchData(targetDate = null) {
  let browser = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    const livePhase = await scrapeFromLive500(context, targetDate);
    if (livePhase.matches.length === 0) {
      return [];
    }

    const tradeMatches = await scrapeFromTrade500(context, livePhase.matches);
    return mergeMatchData(livePhase.matches, tradeMatches);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
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
        row.crownAsia = crownAsia;
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

      const crownRow = parsed.find((item) => /\u7687\u51A0|crown/i.test(item.company));
      if (crownRow) {
        return {
          homeWater: crownRow.homeWater,
          handicap: crownRow.handicap,
          awayWater: crownRow.awayWater,
        };
      }

      const firstRow = parsed[0];
      if (firstRow) {
        return {
          homeWater: firstRow.homeWater,
          handicap: firstRow.handicap,
          awayWater: firstRow.awayWater,
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
};
