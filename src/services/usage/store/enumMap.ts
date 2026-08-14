/**
 * Model and provider identifiers are enums on disk and strings from the
 * language server. Placeholder models follow 1000 + N (verified across
 * M20, M26, M71, M72, M73, M132, M187). Anything else must be learned from
 * the server, and until it is, must be visibly unknown rather than guessed.
 */

export const UNKNOWN_MODEL_PREFIX = 'MODEL_UNKNOWN_';
export const UNKNOWN_PROVIDER_PREFIX = 'API_PROVIDER_UNKNOWN_';

/** Providers observed paired with their server-side names. */
const PROVIDER_SEED: Record<number, string> = {
    24: 'API_PROVIDER_GOOGLE_GEMINI',
    26: 'API_PROVIDER_ANTHROPIC_VERTEX',
};

export function modelNameFromEnum(n: number, learned?: Record<number, string>): string {
    const known = learned?.[n];
    if (known) return known;
    if (n > 1000 && n < 2000) return `MODEL_PLACEHOLDER_M${n - 1000}`;
    return `${UNKNOWN_MODEL_PREFIX}${n}`;
}

export function providerNameFromEnum(n: number, learned?: Record<number, string>): string {
    return learned?.[n] || PROVIDER_SEED[n] || `${UNKNOWN_PROVIDER_PREFIX}${n}`;
}

export function isUnknownEnumName(name: string): boolean {
    return name.startsWith(UNKNOWN_MODEL_PREFIX) || name.startsWith(UNKNOWN_PROVIDER_PREFIX);
}
