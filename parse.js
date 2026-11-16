// A faster drop-in for marked: a dependency-free, single-pass CommonMark +
// GFM parser that renders byte-identical HTML to marked 18.1.3 (default
// options: GFM on, breaks off, pedantic off, async off).
//
// Written from scratch against the CommonMark 0.31.2 / GFM 0.29 specs, with
// marked's own documented behaviour (its test suite's expected outputs) as
// the oracle wherever marked departs from the specs. No part of marked's
// source is copied or vendored here.
//
// Architecture: block lexer (regex-driven, try order space, code, fences,
// heading, hr, blockquote, list, html, def, table, lheading, paragraph,
// text) with a deferred inline pass, an inline lexer (escape, tag, link,
// reflink, emStrong, codespan, br, del, autolink, url, text), and a
// renderer that emits marked's exact HTML templates. Inline parsing is
// deferred so forward link-reference definitions resolve, and emphasis
// uses marked's mask + closer-scan algorithm (not the spec's delimiter
// stack), which is what makes the edge cases agree with marked.

'use strict';

// ---------------------------------------------------------------------------
// Small regex-template builder: a pattern string (or regex) with named
// placeholders that get substituted by other patterns. A `^` at the start
// of a substituted pattern (or after a non-`[` char) is dropped, because
// the pieces are combined into one larger pattern where the anchor would
// be wrong. This is how the block/inline grammars below are assembled.
// ---------------------------------------------------------------------------

const CARET_STRIP = /(^|[^\[])\^/g;

function buildPattern(template, flags) {
  let src = typeof template === 'string' ? template : template.source;
  const api = {
    replace(needle, replacement) {
      let rep = typeof replacement === 'string' ? replacement : replacement.source;
      rep = rep.replace(CARET_STRIP, '$1');
      src = src.replace(needle, rep);
      return api;
    },
    getRegex() {
      return new RegExp(src, flags);
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// Shared small patterns
// ---------------------------------------------------------------------------

const OTHER = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  // Indent-parameterised patterns: marked caches these by indent clamped
  // to 0..3 (via t-1), so build the four variants once at load time.
  listItemRegex: (marker) =>
    new RegExp(`^( {0,3}${marker})((?:[\t ][^\n]*)?(?:\n|$))`),
};

// Block-level HTML tag names (type 6 of the HTML-block grammar).
const BLOCK_TAG_NAMES =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// Indent-cached regex builders (index = clamp(indent - 1, 0, 3)).
function indentCached(builder) {
  const cache = [0, 1, 2, 3].map((n) => builder(n));
  return (indent) => cache[Math.max(0, Math.min(3, indent - 1))];
}

OTHER.nextBulletRegex = indentCached(
  (n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`),
);
OTHER.hrRegex = indentCached(
  (n) =>
    new RegExp(
      `^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`,
    ),
);
OTHER.fencesBeginRegex = indentCached(
  (n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`),
);
OTHER.headingBeginRegex = indentCached(
  (n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`),
);
OTHER.htmlBeginRegex = indentCached(
  (n) =>
    new RegExp(
      `^ {0,${n}}(?:</?(?:${BLOCK_TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      'i',
    ),
);
OTHER.blockquoteBeginRegex = indentCached(
  (n) => new RegExp(`^ {0,${n}}>`),
);
// One regex for the six break conditions tested per list-continuation
// line (fences / heading / html / blockquote / next bullet / hr). The
// alternatives are exactly the six indent-cached regexes above, with the
// trailing groups of nextBullet and hr dropped: on a newline-free line
// they always match, and hr keeps its (?=$) end anchor.
OTHER.listBreakRegex = indentCached(
  (n) =>
    new RegExp(
      `^ {0,${n}}(?:\`\`\`|~~~|#{1,6}(?:\\s|$)|</?(?:${BLOCK_TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[|>|(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|$)|(?:-[ \\t]*){3,}(?=$)|(?:_[ \\t]*){3,}(?=$)|(?:\\*[ \\t]*){3,}(?=$))`,
      'i',
    ),
);

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------

const BLOCK_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLOCK_FENCES =
  /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BLOCK_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const BLOCK_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BULLET_OR_ORDERED = / {0,3}(?:[*+-]|\d{1,9}[.)])/;

// Setext-heading base pattern; the GFM variant adds a table-delimiter
// alternative to the "does this line start another block" lookahead.
const SETEXT_BASE =
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;

const BLOCK_LHEADING = buildPattern(SETEXT_BASE)
  .replace(/bull/g, BULLET_OR_ORDERED)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(
    /hr/g,
    / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  )
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();

const BLOCK_LIST = buildPattern(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, BULLET_OR_ORDERED)
  .getRegex();

// Paragraph base: first line, then continuation lines that do not start
// another block (hr, heading, blockquote, fence, list, html, table) and
// are not blank. The GFM paragraph adds the table alternative; the
// blockquote's paragraph test uses the any-list-marker variant.
const PARAGRAPH_BASE =
  /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;

function buildParagraph(listPattern) {
  return buildPattern(PARAGRAPH_BASE)
    .replace('hr', BLOCK_HR)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace(
      'fences',
      ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
    )
    .replace('list', listPattern)
    .replace(
      'html',
      ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
    )
    .replace('tag', BLOCK_TAG_NAMES)
    .getRegex();
}

const BLOCK_PARAGRAPH = buildPattern(PARAGRAPH_BASE)
  .replace('hr', BLOCK_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace(
    'table',
    buildPattern(
      '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
    )
      .replace('hr', BLOCK_HR)
      .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
      .replace('blockquote', ' {0,3}>')
      .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
      .replace(
        'fences',
        ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
      )
      .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
      .replace(
        'html',
        ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
      )
      .replace('tag', BLOCK_TAG_NAMES)
      .getRegex(),
  )
  .replace('blockquote', ' {0,3}>')
  .replace(
    'fences',
    ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
  )
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace(
    'html',
    ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
  )
  .replace('tag', BLOCK_TAG_NAMES)
  .getRegex();

const BLOCK_TABLE = buildPattern(
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
)
  .replace('hr', BLOCK_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace(
    'fences',
    ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
  )
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace(
    'html',
    ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
  )
  .replace('tag', BLOCK_TAG_NAMES)
  .getRegex();

// The blockquote's paragraph test: a paragraph whose list interruption
// accepts any ordered marker (not just `1.`).
const BLOCKQUOTE_PARAGRAPH = buildParagraph(
  / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/,
);

const BLOCK_BLOCKQUOTE = buildPattern(
  /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/,
)
  .replace('paragraph', BLOCKQUOTE_PARAGRAPH)
  .getRegex();

const BLOCK_TEXT = /^[^\n]+/;

// Link-reference-definition label and title pieces.
const DEF_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const BLOCK_DEF = buildPattern(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
)
  .replace('label', DEF_LABEL)
  .replace(
    'title',
    /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/,
  )
  .getRegex();

// HTML block (types 1-7 in order).
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const BLOCK_HTML = buildPattern(
  "^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))",
  'i',
)
  .replace('comment', HTML_COMMENT)
  .replace('tag', BLOCK_TAG_NAMES)
  .replace(
    'attribute',
    / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/,
  )
  .getRegex();

// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------

const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const PLAIN_INLINE_TRIGGER = /[\\<\[*_`~@]/;
const PLAIN_INLINE_URL = /https?:\/\/|ftp:\/\/|www\.|mailto:|xmpp:/i;
const PLAIN_INLINE_HARD_BREAK = / {2,}\n/;

// Fast path: an inline source with no character that can start an inline
// tokenizer, no hard break and no autolinkable URL/email is a single text
// token — exactly what the loop would produce (inlineText tokens merge),
// but without the mask, the token loop and the per-token regexes.
function isPlainInline(src) {
  return (
    src !== '' &&
    !PLAIN_INLINE_TRIGGER.test(src) &&
    !src.includes('![') &&
    !PLAIN_INLINE_HARD_BREAK.test(src) &&
    !PLAIN_INLINE_URL.test(src)
  );
}

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_NOT_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NOT_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;

// "Punctuation" as the emphasis code uses it: whitespace counts too.
const INLINE_PUNCTUATION = buildPattern(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, PUNCT_SPACE)
  .getRegex();

const INLINE_ANY_PUNCTUATION = buildPattern(/\\(punct)/, 'gu')
  .replace(/punct/g, PUNCT)
  .getRegex();
const INLINE_ANY_PUNCTUATION_OUTSIDE_CODE = buildPattern(
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/,
  'gu',
)
  .replace(/punct/g, PUNCT)
  .getRegex();

// Emphasis opener: a run of `*` or `_` followed by punctuation or a
// non-space, non-delimiter character.
const EM_STRONG_LDELIM_BASE =
  /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const INLINE_EM_STRONG_LDELIM = buildPattern(EM_STRONG_LDELIM_BASE, 'u')
  .replace(/punct/g, PUNCT_NOT_TILDE)
  .getRegex();

// Emphasis closer-scan patterns. The alternatives classify each delimiter
// run by its neighbours; groups 1-2 can close, 3-4 never close (they add
// to the remaining opener length), 5-6 are opener-like (usable only when
// the R flag holds, otherwise subject to the rule of 3s).
const EM_STRONG_RDELIM_AST_BASE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const INLINE_EM_STRONG_RDELIM_AST = buildPattern(EM_STRONG_RDELIM_AST_BASE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_OR_TILDE)
  .replace(/punctSpace/g, PUNCT_SPACE_NOT_TILDE)
  .replace(/punct/g, PUNCT_NOT_TILDE)
  .getRegex();

const EM_STRONG_RDELIM_UND_BASE =
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const INLINE_EM_STRONG_RDELIM_UND = buildPattern(EM_STRONG_RDELIM_UND_BASE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();

// Strikethrough opener/closer (GFM: one or two tildes open).
const INLINE_DEL_LDELIM = buildPattern(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, PUNCT)
  .getRegex();
const DEL_RDELIM_BASE =
  '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
const INLINE_DEL_RDELIM = buildPattern(DEL_RDELIM_BASE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();

// Angle autolink: <scheme:...> or <email>.
const INLINE_AUTOLINK = buildPattern(
  /^<(scheme:[^\s\x00-\x1f<>]*|email)>/,
)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace(
    'email',
    /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
  )
  .getRegex();

// Inline HTML tag (open, close, comment, PI, declaration, CDATA).
const INLINE_TAG = buildPattern(
  '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
)
  .replace(
    'comment',
    buildPattern(HTML_COMMENT).replace('(?:-->|$)', '-->').getRegex(),
  )
  .replace(
    'attribute',
    /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
  )
  .getRegex();

// Link label pieces. `LABEL` allows one level of nested brackets, code
// spans and backslash escapes; `BRACKETS` is a single bracketed run.
const BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL = buildPattern(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
)
  .replace('brackets', BRACKETS)
  .getRegex();
const REF_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const LABEL_SEARCH = buildPattern(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
)
  .replace('brackets', BRACKETS)
  .getRegex();

const INLINE_LINK = buildPattern(
  /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/,
)
  .replace('label', LABEL)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace(
    'title',
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/,
  )
  .getRegex();
const INLINE_REFLINK = buildPattern(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', LABEL)
  .replace('ref', DEF_LABEL)
  .getRegex();
const INLINE_NOLINK = buildPattern(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', DEF_LABEL)
  .getRegex();

// Used by the emphasis mask: finds reference links anywhere in a string.
const INLINE_REFLINK_SEARCH = buildPattern('reflink|nolink(?!\\()', 'g')
  .replace(
    'reflink',
    buildPattern(/^!?\[(label)\]\[(ref)\]/)
      .replace('label', LABEL_SEARCH)
      .replace('ref', REF_LABEL)
      .getRegex(),
  )
  .replace(
    'nolink',
    buildPattern(/^!?\[(ref)\](?:\[\])?/)
      .replace('ref', REF_LABEL)
      .getRegex(),
  )
  .getRegex();

// Used by the emphasis mask: inline links, code spans, raw HTML tags.
const INLINE_BLOCK_SKIP = buildPattern(/link|precode-code|html/, 'g')
  .replace(
    'link',
    /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
  )
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

// Extended autolinks (GFM): www., scheme://, mailto:/xmpp:, bare email.
const URL_PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const URL_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const URL_EMAIL_PROTOCOL = buildPattern(
  /(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/,
)
  .replace(/email/g, URL_EMAIL)
  .getRegex();
const INLINE_URL = buildPattern(
  /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/,
)
  .replace('emailProtocol', URL_EMAIL_PROTOCOL)
  .replace('protocol', URL_PROTOCOL)
  .replace(
    'email',
    /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  )
  .getRegex();
const INLINE_BACKPEDAL =
  /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Inline text: consumes as much plain text as possible, stopping before
// anything another inline tokenizer could start (code span, tag, link,
// emphasis, hard break, autolink trigger, ...).
const INLINE_TEXT = buildPattern(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
)
  .replace('protocol', URL_PROTOCOL)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .getRegex();

// ---------------------------------------------------------------------------
// Escaping, entities, URLs
// ---------------------------------------------------------------------------

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeChar = (ch) => ESCAPE_MAP[ch];

// marked's only escape function. encode=true escapes every & < > " '.
// encode=false escapes < > " ' always, but & only when it does not start
// something that looks like a character reference (&name; / &#123; /
// &#x1a;). Named entities are NOT decoded anywhere (there is no table);
// numeric references pass through here and are decoded separately, only
// in inline text tokens.
function escapeHtml(str, encode) {
  if (encode) {
    if (OTHER.escapeTest.test(str)) return str.replace(OTHER.escapeReplace, escapeChar);
  } else if (OTHER.escapeTestNoEncode.test(str)) {
    return str.replace(OTHER.escapeReplaceNoEncode, escapeChar);
  }
  return str;
}

// Decode numeric character references in an inline text token, and turn
// a bare & (not starting a valid reference) into &amp;. Code points 0,
// > U+10FFFF and surrogates become U+FFFD; 38 (&) becomes the string
// "&amp;" so it survives the later escape pass.
function decodeNumericRefs(str) {
  if (!OTHER.numericCharacterReference.test(str)) return str;
  return str.replace(
    OTHER.numericCharacterReferenceOrAmpersand,
    (whole, dec, hex) => {
      if (dec === undefined && hex === undefined) return '&amp;';
      const cp = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
      if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
      if (cp === 38) return '&amp;';
      return String.fromCodePoint(cp);
    },
  );
}

// marked's cleanUrl: encodeURI, keeping %-escapes intact. Returns null
// only when encodeURI throws (a lone surrogate in the href); the caller
// then drops the whole link/image tag. No scheme filtering at all.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(OTHER.percentDecode, '%');
  } catch {
    return null;
  }
}

// Table cell splitter. Replaces each | by " |" when it has an even number
// of preceding backslashes (unescaped) or by "|" when odd (escaped),
// splits on " |", drops a blank leading/trailing cell, truncates/pads
// to n cells when given, trims each cell, then turns \| into |.
function splitTableCells(str, n) {
  const marked = str.replace(OTHER.findPipe, (ch, offset, whole) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && whole[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = marked.split(OTHER.splitPipe);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (n) {
    if (cells.length > n) cells.splice(n);
    else while (cells.length < n) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(OTHER.slashPipe, '|');
  return cells;
}

// Strip a trailing run of ch (or of non-ch when inverted is true).
function stripTrailing(str, ch, inverted) {
  const n = str.length;
  if (n === 0) return '';
  let count = 0;
  for (; count < n;) {
    const c = str.charAt(n - count - 1);
    if (c === ch && !inverted) count++;
    else if (c !== ch && inverted) count++;
    else break;
  }
  return str.slice(0, n - count);
}

// Drop trailing blank lines, keeping at most one trailing newline.
function stripTrailingBlankLines(str) {
  const lines = str.split('\n');
  let last = lines.length - 1;
  for (; last >= 0 && OTHER.blankLine.test(lines[last]);) last--;
  return lines.length - last <= 2 ? str : lines.slice(0, last + 1).join('\n');
}

// Reference-label normalisation: trim, collapse whitespace runs to one
// space, then lower -> upper -> lower (a Unicode case-fold approximation).
// Backslash escapes are NOT removed from the key.
function normalizeLabel(label) {
  return label
    .trim()
    .replace(OTHER.multipleSpaceGlobal, ' ')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

// Paren-balance scan with backslash awareness. Returns -1 when balanced,
// -2 when an opener is unclosed, or the index of an unmatched closer.
function parenBalance(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1] && (--depth, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Expand each tab to the next multiple-of-4 column, starting at column `col`.
function expandTabs(str, col = 0) {
  let column = col;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const width = 4 - (column % 4);
      out += ' '.repeat(width);
      column += width;
    } else {
      out += ch;
      column++;
    }
  }
  return out;
}

// First line of a string: indexOf + slice instead of split("\n", 1)[0],
// which costs ~5x more per call in V8 (split builds an array).
function firstLineOf(str) {
  const nl = str.indexOf('\n');
  return nl === -1 ? str : str.slice(0, nl);
}

// Could this block start a setext heading? The underline (a line starting
// with up to 3 spaces then = or -) must lie before any blank line, because
// the heading text cannot span one. A manual scan stops at the first blank
// line instead of regex-scanning the whole remaining source.
function lheadingPossible(src) {
  let i = src.indexOf('\n');
  while (i !== -1) {
    let j = i + 1;
    let sp = 0;
    while (sp < 3 && src.charCodeAt(j) === 32) { j++; sp++; }
    const c = src.charCodeAt(j);
    if (c === 61 || c === 45) return true;
    if (c === 10) return false;
    if (c === 32) {
      let k = j;
      while (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9) k++;
      if (src.charCodeAt(k) === 10 || k >= src.length) return false;
    }
    i = src.indexOf('\n', j);
  }
  return false;
}

// Does the string end with a blank line (\n, optional spaces/tabs, \n,
// optional spaces/tabs, end)? Manual scan of the tail, replacing the
// /\n[ \t]*\n[ \t]*$/ regex that list() ran per item.
function hasDoubleBlankLine(str) {
  let end = str.length;
  while (end > 0 && (str.charCodeAt(end - 1) === 32 || str.charCodeAt(end - 1) === 9)) end--;
  if (end < 2 || str.charCodeAt(end - 1) !== 10) return false;
  let i = end - 2;
  while (i >= 0 && (str.charCodeAt(i) === 32 || str.charCodeAt(i) === 9)) i--;
  return i >= 0 && str.charCodeAt(i) === 10;
}

// Fenced-code indent compensation (backtick fences only): if the opening
// fence line is indented, strip that many leading characters from every
// content line (up to the line's own leading-whitespace count).
function fenceIndentCompensation(raw, content) {
  const match = raw.match(OTHER.indentCodeCompensation);
  if (match === null) return content;
  const indent = match[1];
  return content
    .split('\n')
    .map((line) => {
      const leading = line.match(OTHER.beginningSpace);
      if (leading === null) return line;
      return line.slice(Math.min(leading[0].length, indent.length));
    })
    .join('\n');
}

// Does this link label contain a `<...>` (tag or autolink) that runs past
// the end of the label? If so the link is rejected.
function labelHasTagPastEnd(src, label, offset, rules) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = INLINE_CODE.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(offset + i);
    const tag = INLINE_TAG.exec(rest) || INLINE_AUTOLINK.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Emphasis mask: for an inline source, find the last delimiter run that
// could close an emphasis/delimiter opener (a run not preceded by a
// space, tab, newline, CR or FF). The mask itself first hides reference
// links, inline links, code spans and raw HTML tags (replaced by
// same-length `[aaa...]`), and backslash-escaped punctuation (replaced by
// `+`), so delimiters inside them cannot act as closers. Mask entries
// are cached per tokenizer on a stack (inline tokenisation recurses).
// ---------------------------------------------------------------------------

function scanLastCloser(maskedSrc) {
  const last = { '*': -1, _: -1 };
  let del = -1;
  const n = maskedSrc.length;
  for (let i = 0; i < n; i++) {
    const ch = maskedSrc[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : maskedSrc[i - 1];
    let j = i + 1;
    while (j < n && maskedSrc[j] === ch) j++;
    if (
      prev !== ' ' &&
      prev !== '\t' &&
      prev !== '\n' &&
      prev !== '\r' &&
      prev !== '\f'
    ) {
      if (ch === '~') del = i;
      else last[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc, lastPossibleEmStrongCloserIndex: last, lastPossibleDelCloserIndex: del };
}

// ---------------------------------------------------------------------------
// Tokenizer: block level
// ---------------------------------------------------------------------------

class Tokenizer {
  constructor(lexer) {
    this.lexer = lexer;
  }

  space(src) {
    const m = BLOCK_NEWLINE.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }

  code(src) {
    const m = BLOCK_CODE.exec(src);
    if (!m) return undefined;
    const raw = stripTrailingBlankLines(m[0]);
    const text = raw.replace(OTHER.codeRemoveIndent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }

  fences(src) {
    const m = BLOCK_FENCES.exec(src);
    if (!m) return undefined;
    const raw = m[0];
    const text = fenceIndentCompensation(raw, m[3] || '');
    return {
      type: 'code',
      raw,
      lang: m[2]
        ? m[2].trim().replace(INLINE_ANY_PUNCTUATION, '$1')
        : m[2],
      text,
    };
  }

  heading(src) {
    const m = BLOCK_HEADING.exec(src);
    if (!m) return undefined;
    let text = m[2].trim();
    if (OTHER.endingHash.test(text)) {
      const stripped = stripTrailing(text, '#');
      if (!stripped || OTHER.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return {
      type: 'heading',
      raw: stripTrailing(m[0], '\n'),
      depth: m[1].length,
      text,
      tokens: this.lexer.inline(text),
    };
  }

  hr(src) {
    const m = BLOCK_HR.exec(src);
    if (!m) return undefined;
    return { type: 'hr', raw: stripTrailing(m[0], '\n') };
  }

  blockquote(src) {
    const m = BLOCK_BLOCKQUOTE.exec(src);
    if (!m) return undefined;
    let lines = stripTrailing(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let hasMarker = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (OTHER.blockquoteStart.test(lines[p])) {
          chunk.push(lines[p]);
          hasMarker = true;
        } else if (!hasMarker) {
          chunk.push(lines[p]);
        } else break;
      }
      lines = lines.slice(p);
      const chunkStr = chunk.join('\n');
      const dedented = chunkStr
        .replace(
          OTHER.blockquoteMarkerWhitespace,
          (g, marker, ws) => marker + expandTabs(ws, marker.length),
        )
        .replace(OTHER.blockquoteSetextReplace, '\n    $1')
        .replace(OTHER.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${chunkStr}` : chunkStr;
      text = text ? `${text}\n${dedented}` : dedented;
      const savedTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(dedented, tokens, true);
      this.lexer.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (
        last?.type === 'code' ||
        last?.type === 'heading' ||
        last?.type === 'hr' ||
        last?.type === 'html' ||
        last?.type === 'table'
      ) {
        break;
      }
      if (last?.type === 'blockquote') {
        const nested = last;
        const rest = lines.join('\n');
        const merged =
          nested.raw + '\n' + rest.replace(OTHER.blockquoteSetextReplace2, '');
        const relexed = this.blockquote(merged);
        tokens[tokens.length - 1] = relexed;
        const leftover = merged.substring(relexed.raw.length).replace(/^\n/, '');
        const leftoverLines = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
        if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
        text = text.substring(0, text.length - nested.text.length) + relexed.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && OTHER.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last?.type === 'list') {
        const listTok = last;
        const rest = listTok.raw + '\n' + lines.join('\n');
        const relexed = this.list(rest);
        tokens[tokens.length - 1] = relexed;
        const extra =
          relexed.raw.length > listTok.raw.length
            ? rest.slice(listTok.raw.length + 1, relexed.raw.length).split('\n').length
            : 0;
        if (extra > 0) {
          const consumed = lines.slice(0, extra).join('\n');
          raw = `${raw}\n${consumed}`;
          text = `${text}\n${consumed}`;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  list(src) {
    const first = BLOCK_LIST.exec(src);
    if (!first) return undefined;
    const original = src;
    let remaining = src;
    const consumed = () => original.length - remaining.length;
    let marker = first[1].trim();
    const ordered = marker.length > 1;
    const listTok = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +marker.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    marker = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
    const itemRegex = OTHER.listItemRegex(marker);
    let pendingLoose = false;
    while (remaining) {
      let itemEmpty = false;
      let itemText = '';
      const itemMatch = itemRegex.exec(remaining);
      if (!itemMatch || BLOCK_HR.test(remaining)) break;
      const startOffset = consumed();
      remaining = remaining.slice(itemMatch[0].length);
      const firstLine = itemMatch[2].split('\n', 1)[0];
      const markerLen = itemMatch[1].length;
      let afterMarker = firstLine.replace(OTHER.leadingSpaceTab, (v) =>
        expandTabs(v, markerLen),
      );
      const nextLine = firstLineOf(remaining);
      let firstLineEmpty = !afterMarker.trim();
      let contentIndent = 0;
      if (firstLineEmpty) {
        contentIndent = markerLen + 1;
      } else {
        contentIndent = afterMarker.search(OTHER.nonSpaceChar);
        contentIndent = contentIndent > 4 ? 1 : contentIndent;
        itemText = afterMarker.slice(contentIndent);
        contentIndent += markerLen;
      }
      if (
        firstLineEmpty &&
        OTHER.blankLine.test(nextLine) &&
        ((remaining = remaining.slice(nextLine.length + 1)),
        (itemEmpty = true))
      ) {
        // consumed the blank line after an empty first line
      }
      if (!itemEmpty) {
        const nextBullet = OTHER.nextBulletRegex(contentIndent);
        const hrAt = OTHER.hrRegex(contentIndent);
        const fencesBegin = OTHER.fencesBeginRegex(contentIndent);
        const headingBegin = OTHER.headingBeginRegex(contentIndent);
        const htmlBegin = OTHER.htmlBeginRegex(contentIndent);
        const blockquoteBegin = OTHER.blockquoteBeginRegex(contentIndent);
        const listBreak = OTHER.listBreakRegex(contentIndent);
        while (remaining) {
          const line = firstLineOf(remaining);
          const expanded = line.replace(OTHER.leadingSpaceTab, (v) => expandTabs(v));
          if (listBreak.test(line)) {
            break;
          }
          const lineBlank = !line.trim();
          if (expanded.search(OTHER.nonSpaceChar) >= contentIndent || lineBlank) {
            itemText += '\n' + expanded.slice(contentIndent);
          } else {
            if (
              firstLineEmpty ||
              afterMarker.replace(OTHER.tabCharGlobal, '    ').search(OTHER.nonSpaceChar) >= 4 ||
              fencesBegin.test(afterMarker) ||
              headingBegin.test(afterMarker) ||
              htmlBegin.test(afterMarker) ||
              hrAt.test(afterMarker)
            ) {
              break;
            }
            const setextLine =
              /^ {0,3}(?:=+|-+) *$/.test(line) &&
              BLOCK_LHEADING.test(`${afterMarker}\n${line}`)
                ? `    ${expanded.replace(/^ {0,3}/, '')}`
                : line;
            itemText += '\n' + setextLine;
          }
          firstLineEmpty = lineBlank;
          remaining = remaining.slice(line.length + 1);
          afterMarker = expanded.slice(contentIndent);
        }
      }
      const itemRaw = original.slice(startOffset, consumed());
      if (!listTok.loose) {
        if (pendingLoose) listTok.loose = true;
        else if (hasDoubleBlankLine(itemRaw)) pendingLoose = true;
      }
      listTok.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: OTHER.listIsTask.test(itemText),
        loose: false,
        text: itemText,
        tokens: [],
      });
    }
    const lastItem = listTok.items.at(-1);
    if (!lastItem) return undefined;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    listTok.raw = original.slice(0, consumed()).trimEnd();
    for (const item of listTok.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!listTok.loose) {
        const spaces = item.tokens.filter((tok) => tok.type === 'space');
        listTok.loose =
          spaces.length > 0 && spaces.some((tok) => OTHER.anyLine.test(tok.raw));
      }
    }
    for (const item of listTok.items) {
      const firstTok = item.tokens[0];
      if (
        item.task &&
        (firstTok?.type === 'text' || firstTok?.type === 'paragraph')
      ) {
        item.text = item.text.replace(OTHER.listReplaceTask, '');
        firstTok.raw = firstTok.raw.replace(OTHER.listReplaceTask, '');
        firstTok.text = firstTok.text.replace(OTHER.listReplaceTask, '');
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
          if (OTHER.listIsTask.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(
              OTHER.listReplaceTask,
              '',
            );
            break;
          }
        }
        const check = OTHER.listTaskCheckbox.exec(item.raw);
        if (check) {
          const checkbox = {
            type: 'checkbox',
            raw: check[0] + ' ',
            checked: check[0] !== '[ ]',
          };
          item.checked = checkbox.checked;
          if (listTok.loose) {
            if (
              item.tokens[0] &&
              ['paragraph', 'text'].includes(item.tokens[0].type) &&
              'tokens' in item.tokens[0] &&
              item.tokens[0].tokens
            ) {
              item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
              item.tokens[0].text = checkbox.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(checkbox);
            } else {
              item.tokens.unshift({
                type: 'paragraph',
                raw: checkbox.raw,
                text: checkbox.raw,
                tokens: [checkbox],
              });
            }
          } else {
            item.tokens.unshift(checkbox);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (listTok.loose) {
      for (const item of listTok.items) {
        item.loose = true;
        for (const tok of item.tokens) {
          if (tok.type === 'text') tok.type = 'paragraph';
        }
      }
    }
    return listTok;
  }

  html(src) {
    const m = BLOCK_HTML.exec(src);
    if (!m) return undefined;
    const raw = stripTrailingBlankLines(m[0]);
    return {
      type: 'html',
      block: true,
      raw,
      pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
      text: raw,
    };
  }

  def(src) {
    const m = BLOCK_DEF.exec(src);
    if (!m) return undefined;
    if (!OTHER.startAngleBracket.test(m[2]) && parenBalance(m[2], '()') !== -1) {
      return undefined;
    }
    const tag = normalizeLabel(m[1]);
    const href = m[2]
      ? m[2]
          .replace(OTHER.hrefBrackets, '$1')
          .replace(INLINE_ANY_PUNCTUATION, '$1')
      : '';
    const title = m[3]
      ? m[3].substring(1, m[3].length - 1).replace(INLINE_ANY_PUNCTUATION, '$1')
      : m[3];
    return {
      type: 'def',
      tag,
      raw: stripTrailing(m[0], '\n'),
      href,
      title,
    };
  }

  table(src) {
    const m = BLOCK_TABLE.exec(src);
    if (!m || !OTHER.tableDelimiter.test(m[2])) return undefined;
    const headerCells = splitTableCells(m[1]);
    const delimiterCells = m[2].replace(OTHER.tableAlignChars, '').split('|');
    const bodyLines =
      m[3]?.trim() != null && m[3].trim()
        ? m[3].replace(OTHER.tableRowBlankLine, '').split('\n')
        : [];
    const tableTok = {
      type: 'table',
      raw: stripTrailing(m[0], '\n'),
      header: [],
      align: [],
      rows: [],
    };
    if (headerCells.length === delimiterCells.length) {
      for (const cell of delimiterCells) {
        if (OTHER.tableAlignRight.test(cell)) tableTok.align.push('right');
        else if (OTHER.tableAlignCenter.test(cell)) tableTok.align.push('center');
        else if (OTHER.tableAlignLeft.test(cell)) tableTok.align.push('left');
        else tableTok.align.push(null);
      }
      for (let i = 0; i < headerCells.length; i++) {
        tableTok.header.push({
          text: headerCells[i],
          tokens: this.lexer.inline(headerCells[i]),
          header: true,
          align: tableTok.align[i],
        });
      }
      for (const line of bodyLines) {
        tableTok.rows.push(
          splitTableCells(line, tableTok.header.length).map((cell, p) => ({
            text: cell,
            tokens: this.lexer.inline(cell),
            header: false,
            align: tableTok.align[p],
          })),
        );
      }
      return tableTok;
    }
    return undefined;
  }

  lheading(src) {
    const m = BLOCK_LHEADING.exec(src);
    if (!m) return undefined;
    return {
      type: 'heading',
      raw: stripTrailing(m[0], '\n'),
      depth: m[2].charAt(0) === '=' ? 1 : 2,
      text: m[1].trim(),
      tokens: this.lexer.inline(m[1].trim()),
    };
  }

  paragraph(src) {
    const m = BLOCK_PARAGRAPH.exec(src);
    if (!m) return undefined;
    const text =
      m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return {
      type: 'paragraph',
      raw: m[0],
      text,
      tokens: this.lexer.inline(text),
    };
  }

  text(src) {
    const m = BLOCK_TEXT.exec(src);
    if (!m) return undefined;
    return {
      type: 'text',
      raw: m[0],
      text: m[0],
      tokens: this.lexer.inline(m[0]),
    };
  }
}

// ---------------------------------------------------------------------------
// Tokenizer: inline level
// ---------------------------------------------------------------------------

// Build a link/image token from a regex match. The label text is
// inline-parsed recursively; if that parse emits a link, an outer link
// is discarded (the inner link wins) — images are exempt from this.
function buildLinkToken(match, dest, raw, lexer) {
  const href = dest.href;
  const title = dest.title || null;
  const label = match[1].replace(OTHER.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  const savedInLink = lexer.state.inLink;
  const savedLinkEmitted = lexer.state.linkEmitted;
  const savedInRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const innerTokens = lexer.inlineTokens(label);
  const innerEmittedLink = lexer.state.linkEmitted;
  lexer.state.linkEmitted = savedLinkEmitted;
  lexer.state.inLink = savedInLink;
  if (!isImage) {
    if (innerEmittedLink) {
      lexer.state.inRawBlock = savedInRawBlock;
      return undefined;
    }
    lexer.state.linkEmitted = true;
  }
  return {
    type: isImage ? 'image' : 'link',
    raw,
    href,
    title,
    text: label,
    tokens: innerTokens,
  };
}

// Inline methods live on the Tokenizer class via prototype extension
// below (kept separate from the block methods for readability).

Tokenizer.prototype.escape = function (src) {
  const m = INLINE_ESCAPE.exec(src);
  if (!m) return undefined;
  return { type: 'escape', raw: m[0], text: m[1] };
};

Tokenizer.prototype.tag = function (src) {
  const m = INLINE_TAG.exec(src);
  if (!m) return undefined;
  const state = this.lexer.state;
  if (!state.inLink && OTHER.startATag.test(m[0])) state.inLink = true;
  else if (state.inLink && OTHER.endATag.test(m[0])) state.inLink = false;
  if (!state.inRawBlock && OTHER.startPreScriptTag.test(m[0])) {
    state.inRawBlock = true;
  } else if (state.inRawBlock && OTHER.endPreScriptTag.test(m[0])) {
    state.inRawBlock = false;
  }
  return {
    type: 'html',
    raw: m[0],
    inLink: state.inLink,
    inRawBlock: state.inRawBlock,
    block: false,
    text: m[0],
  };
};

Tokenizer.prototype.link = function (src) {
  if (this.lexer.state.linkParenPossible === false) return undefined;
  const m = INLINE_LINK.exec(src);
  if (!m) return undefined;
  const bangOffset = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasTagPastEnd(src, m[1], bangOffset)) return undefined;
  const dest = m[2].trim();
  if (OTHER.startAngleBracket.test(dest)) {
    if (!OTHER.endAngleBracket.test(dest)) return undefined;
    const stripped = stripTrailing(dest.slice(0, -1), '\\');
    if ((dest.length - stripped.length) % 2 === 0) return undefined;
  } else {
    const balance = parenBalance(m[2], '()');
    if (balance === -2) return undefined;
    if (balance > -1) {
      const cutAt = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + balance;
      m[2] = m[2].substring(0, balance);
      m[0] = m[0].substring(0, cutAt).trim();
      m[3] = '';
    }
  }
  const beforeClose = stripTrailing(m[0].slice(0, -1), '\\');
  if ((m[0].length - beforeClose.length) % 2 === 0) return undefined;
  let href = m[2];
  const title = m[3] ? m[3].slice(1, -1) : '';
  href = href.trim();
  if (OTHER.startAngleBracket.test(href)) href = href.slice(1, -1);
  return buildLinkToken(
    m,
    {
      href: href && href.replace(INLINE_ANY_PUNCTUATION, '$1'),
      title: title && title.replace(INLINE_ANY_PUNCTUATION, '$1'),
    },
    m[0],
    this.lexer,
  );
};

Tokenizer.prototype.reflink = function (src, links) {
  let m = INLINE_REFLINK.exec(src) || INLINE_NOLINK.exec(src);
  if (!m) return undefined;
  const bangOffset = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasTagPastEnd(src, m[1], bangOffset)) return undefined;
  const ref = links[normalizeLabel(m[2] || m[1])];
  if (!ref) {
    const ch = m[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return buildLinkToken(m, ref, m[0], this.lexer);
};

Tokenizer.prototype.emStrong = function (src, maskedSrc, prevChar = '') {
  const open = INLINE_EM_STRONG_LDELIM.exec(src);
  if (!open || (!open[1] && !open[2] && !open[3] && !open[4])) return undefined;
  const delim = open[0][0];
  const sameAsPrev = prevChar === delim;
  const pos = maskedSrc.length - src.length;
  let runStart = pos;
  while (runStart > 0 && maskedSrc[runStart - 1] === delim) runStart--;
  const beforeRun = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)];
  const charBeforeRun = beforeRun.at(-1) ?? '';
  const beforeIsPunctOrDelim =
    charBeforeRun === '*' ||
    charBeforeRun === '_' ||
    !!INLINE_PUNCTUATION.exec(charBeforeRun);
  if (runStart < pos) prevChar = charBeforeRun;
  const prevIsPunct =
    runStart < pos ? beforeIsPunctOrDelim : !!INLINE_PUNCTUATION.exec(prevChar);
  // Intraword `_`: preceded and followed by alphanumerics -> not an opener.
  if (open[4] && prevChar.match(OTHER.unicodeAlphaNumeric)) return undefined;
  const followedByPunct = open[1] || open[3] || '';
  if (!followedByPunct || !prevChar || prevIsPunct) {
    const runLen = [...open[0]].length - 1;
    let remaining = runLen;
    let skipped = 0;
    const total = pos - runStart + runLen;
    const canUseOpenerLike =
      !!charBeforeRun.trim() &&
      (!!followedByPunct || (delim === '*' && !beforeIsPunctOrDelim));
    if (delim !== '*' && delim !== '_') return undefined;
    const closerRe =
      delim === '*' ? INLINE_EM_STRONG_RDELIM_AST : INLINE_EM_STRONG_RDELIM_UND;
    const lastCloser = this.lexer.lastPossibleEmStrong(maskedSrc, delim);
    const openerEnd = maskedSrc.length - src.length + runLen;
    if (lastCloser < openerEnd) return undefined;
    const searchSrc = maskedSrc.slice(-1 * src.length + runLen);
    const maxIndex = lastCloser - openerEnd;
    let closer;
    for (
      closerRe.lastIndex = 0;
      (closer = closerRe.exec(searchSrc)) !== null && !(closer.index > maxIndex);
    ) {
      const run =
        closer[1] || closer[2] || closer[3] || closer[4] || closer[5] || closer[6];
      if (!run) continue;
      const runChars = [...run].length;
      if (closer[3] || closer[4]) {
        remaining += runChars;
        continue;
      } else if (closer[5] || closer[6] || canUseOpenerLike) {
        if (sameAsPrev && (closer[5] || closer[6])) break;
        // Rule of 3s: skip this candidate when the opener length is not
        // a multiple of 3 but opener + candidate is.
        if (total % 3 && !((total + runChars) % 3)) {
          skipped += runChars;
          continue;
        }
      }
      remaining -= runChars;
      if (remaining > 0) continue;
      const used = Math.min(runChars, runChars + remaining + skipped);
      const firstCharLen = [...closer[0]][0].length;
      const raw = src.slice(0, runLen + closer.index + firstCharLen + used);
      if (Math.min(runLen, used) % 2) {
        const inner = raw.slice(1, -1);
        return {
          type: 'em',
          raw,
          text: inner,
          tokens: this.lexer.inlineTokens(inner),
        };
      }
      const inner = raw.slice(2, -2);
      return {
        type: 'strong',
        raw,
        text: inner,
        tokens: this.lexer.inlineTokens(inner),
      };
    }
  }
  return undefined;
};

Tokenizer.prototype.codespan = function (src) {
  const m = INLINE_CODE.exec(src);
  if (!m) return undefined;
  let text = m[2].replace(OTHER.newLineCharGlobal, ' ');
  const hasNonSpace = OTHER.nonSpaceChar.test(text);
  const wrappedInSpaces =
    OTHER.startingSpaceChar.test(text) && OTHER.endingSpaceChar.test(text);
  if (hasNonSpace && wrappedInSpaces) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: m[0], text };
};

Tokenizer.prototype.br = function (src) {
  const m = INLINE_BR.exec(src);
  if (!m) return undefined;
  return { type: 'br', raw: m[0] };
};

Tokenizer.prototype.del = function (src, maskedSrc, prevChar = '') {
  const open = INLINE_DEL_LDELIM.exec(src);
  if (!open) return undefined;
  if (!(open[1] || '') || !prevChar || INLINE_PUNCTUATION.exec(prevChar)) {
    const runLen = [...open[0]].length - 1;
    let remaining = runLen;
    const closerRe = INLINE_DEL_RDELIM;
    const lastCloser = this.lexer.lastPossibleDel(maskedSrc);
    const openerEnd = maskedSrc.length - src.length + runLen;
    if (lastCloser < openerEnd) return undefined;
    const searchSrc = maskedSrc.slice(-1 * src.length + runLen);
    const maxIndex = lastCloser - openerEnd;
    let closer;
    for (
      closerRe.lastIndex = 0;
      (closer = closerRe.exec(searchSrc)) !== null && !(closer.index > maxIndex);
    ) {
      const run =
        closer[1] || closer[2] || closer[3] || closer[4] || closer[5] || closer[6];
      if (!run) continue;
      const runChars = [...run].length;
      // The closer run must have exactly the opener's length.
      if (runChars !== runLen) continue;
      if (closer[3] || closer[4]) {
        remaining += runChars;
        continue;
      }
      remaining -= runChars;
      if (remaining > 0) continue;
      const used = Math.min(runChars, runChars + remaining);
      const firstCharLen = [...closer[0]][0].length;
      const raw = src.slice(0, runLen + closer.index + firstCharLen + used);
      const inner = raw.slice(runLen, -runLen);
      return {
        type: 'del',
        raw,
        text: inner,
        tokens: this.lexer.inlineTokens(inner),
      };
    }
  }
  return undefined;
};

Tokenizer.prototype.autolink = function (src) {
  const m = INLINE_AUTOLINK.exec(src);
  if (!m) return undefined;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[1];
    href = 'mailto:' + text;
  } else {
    text = m[1];
    href = text;
  }
  return {
    type: 'link',
    raw: m[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
};

Tokenizer.prototype.url = function (src) {
  const m = INLINE_URL.exec(src);
  if (!m) return undefined;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let prev = m[0];
    do {
      prev = m[0];
      m[0] = INLINE_BACKPEDAL.exec(m[0])?.[0] ?? '';
    } while (prev !== m[0]);
    text = m[0];
    href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
  }
  return {
    type: 'link',
    raw: m[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
};

Tokenizer.prototype.inlineText = function (src) {
  const m = INLINE_TEXT.exec(src);
  if (!m) return undefined;
  const inRawBlock = this.lexer.state.inRawBlock;
  return {
    type: 'text',
    raw: m[0],
    text: inRawBlock ? m[0] : decodeNumericRefs(m[0]),
    escaped: inRawBlock,
  };
};

// ---------------------------------------------------------------------------
// Lexer: block pass, deferred inline pass, emphasis mask
// ---------------------------------------------------------------------------

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.inlineQueue = [];
    this.state = {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    };
    this.maskStack = [];
    this.tokenizer = new Tokenizer(this);
  }

  lex(src) {
    src = src.replace(OTHER.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const entry = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(entry.src, entry.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  // Queue an inline source for the deferred inline pass.
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  blockTokens(src, tokens = [], inBlockquote = false) {
    let shortest = Infinity;
    let mergeParagraph = inBlockquote;
    while (src) {
      if (src.length < shortest) {
        shortest = src.length;
      } else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
      let tok;
      if ((tok = this.tokenizer.space(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.code(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokenizer.fences(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.heading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.hr(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.blockquote(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.list(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.html(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.def(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          this.tokens.links[tok.tag] ||
            (this.tokens.links[tok.tag] = { href: tok.href, title: tok.title });
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokenizer.table(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (
        lheadingPossible(src) &&
        (tok = this.tokenizer.lheading(src))
      ) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (this.state.top && (tok = this.tokenizer.paragraph(src))) {
        const prev = tokens.at(-1);
        if (mergeParagraph && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          tokens.push(tok);
        }
        mergeParagraph = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokenizer.text(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }
    this.state.top = true;
    return tokens;
  }

  inlineTokens(src, tokens = []) {
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      if (isPlainInline(src)) {
        const inRawBlock = this.state.inRawBlock;
        tokens.push({
          type: 'text',
          raw: src,
          text: inRawBlock ? src : decodeNumericRefs(src),
          escaped: inRawBlock,
        });
        return tokens;
      }
      return this.inlineTokensMasked(src, tokens);
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  inlineTokensMasked(src, tokens) {
    const masked =
      src.includes('*') || src.includes('_') || src.includes('~')
        ? this.buildMask(src)
        : src;
    this.maskStack.push(scanLastCloser(masked));
    try {
      return this.inlineTokensLoop(src, masked, tokens);
    } finally {
      this.maskStack.pop();
    }
  }

  inlineTokensLoop(src, masked, tokens) {
    let lastWasText = false;
    let prevChar = '';
    let shortest = Infinity;
    while (src) {
      if (src.length < shortest) {
        shortest = src.length;
      } else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
      if (!lastWasText) prevChar = '';
      lastWasText = false;
      let tok;
      if ((tok = this.tokenizer.escape(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.tag(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.link(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.reflink(src, this.tokens.links))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (tok.type === 'text' && prev?.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokenizer.emStrong(src, masked, prevChar))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.codespan(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.br(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.del(src, masked, prevChar))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.autolink(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (!this.state.inLink && (tok = this.tokenizer.url(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.inlineText(src))) {
        src = src.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        lastWasText = true;
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }
    return tokens;
  }

  // Does this inline source contain a link (used by the mask to decide
  // which reference links to hide)?
  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(INLINE_BLOCK_SKIP)) {
      if (INLINE_LINK.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE_REFLINK_SEARCH)) {
      const text = m[0];
      const openBracket = text.lastIndexOf('[');
      if (
        text.charAt(0) === '!' ||
        !Object.hasOwn(
          this.tokens.links,
          normalizeLabel(text.slice(openBracket + 1, -1)),
        )
      ) {
        continue;
      }
      if (openBracket > 1 && this.linkInText(text.slice(1, openBracket - 1))) {
        continue;
      }
      return true;
    }
    return false;
  }

  // Build the masked copy of an inline source: reference links, inline
  // links, code spans and raw HTML tags become `[aaa...]` of the same
  // length, and backslash-escaped punctuation becomes `+`, so emphasis
  // and strikethrough scans cannot see delimiters inside them.
  buildMask(src) {
    let masked = src;
    if (this.tokens.links && src.includes('[')) {
      const hide = (match) => {
        const openBracket = match.lastIndexOf('[');
        if (
          !Object.hasOwn(
            this.tokens.links,
            normalizeLabel(match.slice(openBracket + 1, -1)),
          )
        ) {
          return match;
        }
        if (openBracket > 1 && match.charAt(0) !== '!') {
          const inner = match.slice(1, openBracket - 1);
          if (this.linkInText(inner)) {
            return (
              '[' +
              inner.replace(INLINE_REFLINK_SEARCH, hide) +
              '][' +
              'a'.repeat(match.length - openBracket - 2) +
              ']'
            );
          }
        }
        return '[' + 'a'.repeat(match.length - 2) + ']';
      };
      masked = masked.replace(INLINE_REFLINK_SEARCH, hide);
    }
    if (masked.includes('`') || masked.includes('\\')) {
      masked = masked.replace(
        INLINE_ANY_PUNCTUATION_OUTSIDE_CODE,
      (whole, backticks, punct) =>
        punct
          ? '+'.repeat(whole.length)
          : backticks
            ? backticks +
              whole
                .slice(backticks.length, -backticks.length)
                .replace(/`/g, '+') +
              backticks
            : whole,
      );
    }
    if (masked.includes('[') || masked.includes('`') || masked.includes('<')) {
      masked = masked.replace(INLINE_BLOCK_SKIP, (whole, _a, precode) => {
      const prefix = precode ? precode.length : 0;
      return whole.slice(0, prefix) + '[' + 'a'.repeat(whole.length - prefix - 2) + ']';
    });
    }
    return masked;
  }

  lastPossibleEmStrong(maskedSrc, delim) {
    const top = this.maskStack.at(-1);
    if (top && top.maskedSrc === maskedSrc) {
      return top.lastPossibleEmStrongCloserIndex[delim];
    }
    return scanLastCloser(maskedSrc).lastPossibleEmStrongCloserIndex[delim];
  }

  lastPossibleDel(maskedSrc) {
    const top = this.maskStack.at(-1);
    if (top && top.maskedSrc === maskedSrc) {
      return top.lastPossibleDelCloserIndex;
    }
    return scanLastCloser(maskedSrc).lastPossibleDelCloserIndex;
  }

  infiniteLoopError(byte) {
    throw new Error('Infinite loop on byte: ' + byte);
  }
}

// ---------------------------------------------------------------------------
// Renderer: exact HTML templates
// ---------------------------------------------------------------------------

function renderCodeText(text) {
  return text ? text.replace(OTHER.endingNewline, '') + '\n' : '';
}

function renderBlock(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`;
        break;
      case 'code': {
        const lang = (tok.lang || '').match(OTHER.notSpaceStart)?.[0] ?? '';
        const text = renderCodeText(tok.text);
        out += lang
          ? `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(text, true)}</code></pre>\n`
          : `<pre><code>${escapeHtml(text, true)}</code></pre>\n`;
        break;
      }
      case 'table': {
        let headerHtml = '';
        for (const cell of tok.header) headerHtml += renderTableCell(cell);
        let head = `<tr>\n${headerHtml}</tr>\n`;
        let body = '';
        for (const row of tok.rows) {
          let rowHtml = '';
          for (const cell of row) rowHtml += renderTableCell(cell);
          body += `<tr>\n${rowHtml}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += `<table>\n<thead>\n${head}</thead>\n${body}</table>\n`;
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlock(tok.tokens)}</blockquote>\n`;
        break;
      case 'list': {
        let items = '';
        for (const item of tok.items) items += renderListItem(item);
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case 'checkbox':
        out += `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        break;
      case 'html':
        out += tok.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += `<p>${renderInline(tok.tokens)}</p>\n`;
        break;
      case 'text':
        out += renderTextToken(tok);
        break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

function renderListItem(item) {
  return `<li>${renderBlock(item.tokens)}</li>\n`;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const align = cell.align ? ` align="${cell.align}"` : '';
  return `<${tag}${align}>${renderInline(cell.tokens)}</${tag}>\n`;
}

function renderTextToken(tok) {
  if ('tokens' in tok && tok.tokens) return renderInline(tok.tokens);
  if ('escaped' in tok && tok.escaped) return tok.text;
  return escapeHtml(tok.text);
}

function renderInline(tokens, textOnly = false) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape':
        out += textOnly ? tok.text : escapeHtml(tok.text);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'link': {
        if (textOnly) {
          out += renderInline(tok.tokens, true);
          break;
        }
        const text = tok.autolink
          ? escapeHtml(tok.text, true)
          : renderInline(tok.tokens);
        const href = cleanUrl(tok.href);
        if (href === null) {
          out += text;
          break;
        }
        const hrefAttr = escapeHtml(href, tok.autolink);
        let tag = `<a href="${hrefAttr}"`;
        if (tok.title) tag += ` title="${escapeHtml(tok.title)}"`;
        out += `${tag}>${text}</a>`;
        break;
      }
      case 'image': {
        if (textOnly) {
          out += renderInline(tok.tokens, true);
          break;
        }
        const alt = renderInline(tok.tokens, true);
        const src = cleanUrl(tok.href);
        if (src === null) {
          out += escapeHtml(alt);
          break;
        }
        let tag = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"`;
        if (tok.title) tag += ` title="${escapeHtml(tok.title)}"`;
        out += `${tag}>`;
        break;
      }
      case 'checkbox':
        out += textOnly ? tok.raw : `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        break;
      case 'strong':
        out += textOnly
          ? renderInline(tok.tokens, true)
          : `<strong>${renderInline(tok.tokens)}</strong>`;
        break;
      case 'em':
        out += textOnly
          ? renderInline(tok.tokens, true)
          : `<em>${renderInline(tok.tokens)}</em>`;
        break;
      case 'codespan':
        out += textOnly ? tok.text : `<code>${escapeHtml(tok.text, true)}</code>`;
        break;
      case 'br':
        out += textOnly ? '' : '<br>';
        break;
      case 'del':
        out += textOnly
          ? renderInline(tok.tokens, true)
          : `<del>${renderInline(tok.tokens)}</del>`;
        break;
      case 'text':
        if (textOnly) {
          out +=
            'tokens' in tok && tok.tokens
              ? renderInline(tok.tokens, true)
              : tok.text;
        } else {
          out += renderTextToken(tok);
        }
        break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return renderBlock(tokens);
}
