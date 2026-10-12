/**
 * League settings that fleaflicker's API doesn't return (transaction limits, waiver timing),
 * read from the league's rules page, e.g. https://www.fleaflicker.com/nhl/leagues/12089/rules
 *
 * The page lists settings as <dt>name</dt><dd>value</dd> pairs. Times are <local-time> elements
 * with a UTC datetime attribute, e.g. <local-time datetime="2026-10-11T09:00:00Z">5:00 AM EDT</local-time>.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decodeEntities = (text) => text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity) => {
  if (entity[0] === '#') {
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isNaN(code) ? match : String.fromCodePoint(code);
  }
  return ENTITIES[entity.toLowerCase()] ?? match;
});

const textOf = (html) => decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// { 'Time on Waivers After Drop': { text: '24 Hours', times: [] }, ... }
const settingsOf = (html) => {
  const settings = {};
  for (const [, name, value] of html.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    settings[textOf(name)] = {
      text: textOf(value),
      times: [...value.matchAll(/datetime="([^"]+)"/g)].map(match => match[1]),
    };
  }
  return settings;
};

// The hour and minute of a UTC time in Eastern, which is how fleaflicker schedules waivers
const easternTimeOfDay = (isoTime) => {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return { hour: parseInt(parts.hour, 10), minute: parseInt(parts.minute, 10) };
};

const yesNo = (setting) => {
  if (!setting) return null;
  if (/^yes\b/i.test(setting.text)) return true;
  if (/^no\b/i.test(setting.text)) return false;
  return null;
};

// "Week: 7" or "Season: 30". Null when there's no limit or it's in a format we don't know.
const parseTransactionLimit = (setting) => {
  const match = setting?.text.match(/^(\w+):\s*(\d+)$/);
  if (!match) {
    return null;
  }
  return { period: match[1].toLowerCase(), limit: parseInt(match[2], 10) };
};

const parseHours = (setting) => {
  const match = setting?.text.match(/(\d+)\s*Hours?/i);
  if (match) return parseInt(match[1], 10);
  const days = setting?.text.match(/(\d+)\s*Days?/i);
  return days ? parseInt(days[1], 10) * 24 : null;
};

const parseLeagueRules = (html) => {
  const settings = settingsOf(html);
  const setting = (name) => settings[name];
  const placedOnWaivers = setting('Who is Placed on Waivers')?.text ?? null;
  const gameStartLock = setting('Process Game-Start Waivers On');
  const firstComeFirstServed = setting('First-Come-First-Served');

  return {
    transactionLimit: parseTransactionLimit(setting('Transaction Limits')),
    waivers: {
      claimsResolvedBy: setting('How Are Claims Resolved')?.text ?? null,
      placedOnWaivers,
      // Free agents go on waivers once their team's game starts, not only dropped players
      gameStartWaivers: placedOnWaivers === null ? null : /after game start/i.test(placedOnWaivers),
      hoursAfterDrop: parseHours(setting('Time on Waivers After Drop')),
      // Text like "Every day, locking at 5:00 AM EDT"
      gameStartProcessing: gameStartLock?.text ?? null,
      gameStartLockTime: gameStartLock?.times[0] ? easternTimeOfDay(gameStartLock.times[0]) : null,
      firstComeFirstServedTime: firstComeFirstServed?.times[0] ? easternTimeOfDay(firstComeFirstServed.times[0]) : null,
      alwaysOnDuringPreseason: yesNo(setting('Always-On During Preseason')),
    },
    // Every setting on the page as text, for settings not parsed above
    settings: Object.fromEntries(Object.entries(settings).map(([name, value]) => [name, value.text])),
  };
};

module.exports = { parseLeagueRules };
