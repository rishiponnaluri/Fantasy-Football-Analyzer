type TeamPalette = readonly [primary: string, secondary: string];

const NFL_TEAM_PALETTES: Record<string, TeamPalette> = {
  ARI: ['#97233F', '#000000'], ATL: ['#A71930', '#000000'], BAL: ['#241773', '#9E7C0C'], BUF: ['#00338D', '#C60C30'],
  CAR: ['#0085CA', '#101820'], CHI: ['#0B162A', '#C83803'], CIN: ['#FB4F14', '#000000'], CLE: ['#311D00', '#FF3C00'],
  DAL: ['#003594', '#869397'], DEN: ['#FB4F14', '#002244'], DET: ['#0076B6', '#B0B7BC'], GB: ['#203731', '#FFB612'],
  HOU: ['#03202F', '#A71930'], IND: ['#002C5F', '#A2AAAD'], JAX: ['#006778', '#D7A22A'], KC: ['#E31837', '#FFB81C'],
  LAC: ['#0080C6', '#FFC20E'], LAR: ['#003594', '#FFA300'], LV: ['#000000', '#A5ACAF'], MIA: ['#008E97', '#FC4C02'],
  MIN: ['#4F2683', '#FFC62F'], NE: ['#002244', '#C60C30'], NO: ['#D3BC8D', '#101820'], NYG: ['#0B2265', '#A71930'],
  NYJ: ['#125740', '#000000'], PHI: ['#004C54', '#A5ACAF'], PIT: ['#FFB612', '#101820'], SF: ['#AA0000', '#B3995D'],
  SEA: ['#002244', '#69BE28'], TB: ['#D50A0A', '#34302B'], TEN: ['#0C2340', '#4B92DB'], WSH: ['#5A1414', '#FFB612'],
};

function normalizeTeam(team?: string | null) {
  const normalized = String(team || '').trim().toUpperCase().replaceAll('.', '');
  if (normalized === 'WAS' || normalized === 'WFT') return 'WSH';
  if (normalized === 'JAC') return 'JAX';
  if (normalized === 'LA') return 'LAR';
  return normalized;
}

function validColor(color?: string | null) {
  const value = String(color || '').replace(/^#/, '');
  return /^[\da-f]{6}$/i.test(value) ? `#${value}` : null;
}

export function nflTeamPalette(team?: string | null, primary?: string | null, secondary?: string | null): TeamPalette | null {
  const known = NFL_TEAM_PALETTES[normalizeTeam(team)];
  const dataPrimary = validColor(primary);
  const dataSecondary = validColor(secondary);
  if (known) return known;
  return dataPrimary ? [dataPrimary, dataSecondary || '#171b25'] : null;
}
