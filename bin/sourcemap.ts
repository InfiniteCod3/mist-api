/** Reads a source map (version 3), such as the inline one of a plugin that Evi's watch build made */

export interface SourceMap { sources: string[]; names?: string[]; mappings: string; sourceRoot?: string; }
export interface Position { source: string; line: number; column: number; name?: string; }

/** [generated column, source, line, column, name?] segments, 0-based, per generated line */
type Segment = [number, number, number, number, number?];

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeLine(line: string, state: number[]): Segment[] {
    const out: Segment[] = [];
    let column = 0;
    for (const group of line.split(",")) {
        if (!group) continue;
        const fields: number[] = [];
        let value = 0, shift = 0;
        for (const char of group) {
            const digit = BASE64.indexOf(char);
            if (digit < 0) return out;
            value += (digit & 31) << shift;
            if (digit & 32) shift += 5;
            else {
                fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
                value = shift = 0;
            }
        }
        // The generated column restarts on each line; source, line, column and name run on across the whole map
        column += fields[0];
        if (fields.length < 4) continue;
        for (let i = 1; i < fields.length; i++) state[i] += fields[i];
        out.push(fields.length > 4 ? [column, state[1], state[2], state[3], state[4]] : [column, state[1], state[2], state[3]]);
    }
    return out;
}

export function decodeMappings(mappings: string): Segment[][] {
    const state = [0, 0, 0, 0, 0];
    return mappings.split(";").map(line => decodeLine(line, state));
}

/** A data: URL's map, or null when it isn't one or doesn't parse */
export function parseDataUrl(url: string): SourceMap | null {
    const match = /^data:application\/json(?:;charset=[\w-]+)?(;base64)?,(.*)$/s.exec(url);
    if (!match) return null;
    try {
        const json = match[1] ? Buffer.from(match[2], "base64").toString("utf8") : decodeURIComponent(match[2]);
        const map = JSON.parse(json);
        return typeof map?.mappings === "string" && Array.isArray(map.sources) ? map : null;
    } catch {
        return null;
    }
}

export interface Mapper { (line: number, column: number): Position | null; }

/** Looks up 0-based generated positions; the segment at or left of the column, on that line */
export function mapper(map: SourceMap): Mapper {
    const lines = decodeMappings(map.mappings);
    return (line, column) => {
        const segments = lines[line];
        if (!segments?.length) return null;
        let found: Segment | undefined;
        for (const s of segments) {
            if (s[0] > column) break;
            found = s;
        }
        if (!found) return null;
        return {
            source: (map.sourceRoot ?? "") + map.sources[found[1]],
            line: found[2],
            column: found[3],
            ...found[4] !== undefined && map.names?.[found[4]] ? { name: map.names[found[4]] } : {},
        };
    };
}
