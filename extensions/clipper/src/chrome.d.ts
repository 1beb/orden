// Minimal ambient declaration to keep the bundler/typecheck quiet without
// pulling in @types/chrome (which would have to age past the cooldown).
// Replace with @types/chrome later if richer typing is wanted.
declare const chrome: any;
