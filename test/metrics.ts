export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export function parseMetrics(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (match === null) throw new Error(`unparseable metrics line: ${line}`);
    const labels: Record<string, string> = {};
    for (const pair of (match[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      labels[pair[1] ?? ''] = pair[2] ?? '';
    }
    samples.push({ name: match[1] ?? '', labels, value: Number(match[3]) });
  }
  return samples;
}

export function sampleValue(samples: Sample[], name: string, labels: Record<string, string> = {}): number | undefined {
  return samples.find(
    (sample) => sample.name === name && Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
  )?.value;
}

export async function scrape(baseUrl: string): Promise<Sample[]> {
  const response = await fetch(`${baseUrl}/metrics`);
  return parseMetrics(await response.text());
}
