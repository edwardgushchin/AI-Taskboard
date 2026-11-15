// Shared allowlist for read-only source previews in Node and the desktop renderer.
const sourceFile = /\.(?:css|cs|fs|vb|[cm]?js|[cm]?ts|jsx|tsx|py|rs|go|java|kt|swift|[ch]|cc|cpp|cxx|hh|hpp|hxx|rb|php|lua|gd|sh|ps1)$/i;
if (typeof module !== "undefined") module.exports = sourceFile;
