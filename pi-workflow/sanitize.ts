export function sanitizeTuiText(value: string): string {
	let output = "";
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code === 0x1b) {
			const next = value.charCodeAt(i + 1);
			if (next === 0x5b) {
				// CSI: ESC [ ... final byte.
				i += 2;
				while (i < value.length && (value.charCodeAt(i) < 0x40 || value.charCodeAt(i) > 0x7e)) i++;
				continue;
			}
			if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
				// OSC/DCS/SOS/PM/APC: consume through BEL, ST, or the end of input.
				i += 2;
				while (i < value.length) {
					const current = value.charCodeAt(i);
					if (current === 0x07 || current === 0x9c) break;
					if (current === 0x1b && value.charCodeAt(i + 1) === 0x5c) {
						i++;
						break;
					}
					i++;
				}
				continue;
			}
			// Other ESC sequences are still control data; discard ESC and its introducer.
			i += next === undefined ? 0 : 1;
			continue;
		}
		if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
			// C1 forms of OSC/DCS/SOS/PM/APC.
			i++;
			while (i < value.length && value.charCodeAt(i) !== 0x07 && value.charCodeAt(i) !== 0x9c) i++;
			continue;
		}
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			output += " ";
			continue;
		}
		output += value[i];
	}
	return output;
}

export function compactPreview(value: string, maxChars = 140): string {
	const compact = sanitizeTuiText(value).replace(/\s+/g, " ").trim();
	return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}
