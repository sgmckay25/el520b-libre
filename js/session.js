// Historique des séances (stocké dans le navigateur) et exports TCX / CSV.

const KEY = 'el520b.sessions.v1';

// Un échantillon par seconde : [temps s, vitesse ×10 km/h, cadence tr/min, résistance, puissance W, FC bpm, distance m]
const T = 0, SPEED = 1, CADENCE = 2, RES = 3, POWER = 4, HR = 5, DIST = 6;

export function loadSessions() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? [];
  } catch {
    return [];
  }
}

export function storeSessions(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function summarize({ startedAt, elapsed, distance, kcal, samples }) {
  const mean = (rows, i) => (rows.length ? Math.round(rows.reduce((sum, row) => sum + row[i], 0) / rows.length) : 0);
  const moving = samples.filter(row => row[CADENCE] > 0);
  return {
    id: String(startedAt),
    startedAt,
    duration: Math.round(elapsed),
    distance: Math.round(distance),
    kcal: Math.round(kcal),
    avgPower: mean(moving, POWER),
    maxPower: samples.reduce((max, row) => Math.max(max, row[POWER]), 0),
    avgCadence: mean(moving, CADENCE),
    avgHr: mean(samples.filter(row => row[HR] > 0), HR),
    samples,
  };
}

const pad = n => String(n).padStart(2, '0');

export function formatDuration(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function fileStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}`;
}

// TCX : importable dans Strava, Garmin Connect, intervals.icu…
export function toTcx(s) {
  const start = new Date(s.startedAt).toISOString();
  const at = t => new Date(s.startedAt + t * 1000).toISOString();
  const points = s.samples
    .filter((row, i, all) => i === 0 || row[T] !== all[i - 1][T])
    .map(row => [
      '<Trackpoint>',
      `<Time>${at(row[T])}</Time>`,
      `<DistanceMeters>${row[DIST]}</DistanceMeters>`,
      row[HR] ? `<HeartRateBpm><Value>${row[HR]}</Value></HeartRateBpm>` : '',
      `<Cadence>${Math.min(254, row[CADENCE])}</Cadence>`,
      `<Extensions><ns3:TPX><ns3:Speed>${(row[SPEED] / 36).toFixed(2)}</ns3:Speed><ns3:Watts>${row[POWER]}</ns3:Watts></ns3:TPX></Extensions>`,
      '</Trackpoint>',
    ].join(''))
    .join('\n          ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="Other">
      <Id>${start}</Id>
      <Lap StartTime="${start}">
        <TotalTimeSeconds>${s.duration}</TotalTimeSeconds>
        <DistanceMeters>${s.distance}</DistanceMeters>
        <Calories>${s.kcal}</Calories>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
          ${points}
        </Track>
      </Lap>
      <Notes>Vélo elliptique Domyos EL520B</Notes>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
}

// CSV au format français (séparateur ; et virgule décimale) pour Excel / LibreOffice.
export function toCsv(s) {
  const header = 'temps_s;vitesse_kmh;cadence_trmin;resistance;puissance_w;fc_bpm;distance_m';
  const rows = s.samples.map(row => [
    row[T],
    (row[SPEED] / 10).toFixed(1).replace('.', ','),
    row[CADENCE],
    row[RES],
    row[POWER],
    row[HR],
    row[DIST],
  ].join(';'));
  return [header, ...rows].join('\n');
}

export function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
