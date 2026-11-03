/**
 * Colour tokens for the people views (circle identity + wellbeing status), light and dark. Circle hues are the
 * validated categorical palette (fixed order, never cycled); wellbeing uses reserved status colours and is always
 * paired with a word. Rendered once per people page; scoped to .people-scope.
 * TODO(integrator): move into globals.css next to --t-person.
 */
const css = `
.people-scope {
  --c-family: #2a78d6; --c-close: #eb6834; --c-school: #1baf7a; --c-care: #eda100; --c-social: #e87ba4; --c-work: #008300; --c-other: #8a8f96;
  --wb-good: #0ca30c; --wb-neutral: #8a8f96; --wb-warn: #d03b3b; --wb-none: var(--line);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .people-scope {
    --c-family: #3987e5; --c-close: #d95926; --c-school: #199e70; --c-care: #c98500; --c-social: #d55181; --c-work: #008300; --c-other: #8a8f96;
    --wb-neutral: #9aa6b2;
  }
}
:root[data-theme="dark"] .people-scope {
  --c-family: #3987e5; --c-close: #d95926; --c-school: #199e70; --c-care: #c98500; --c-social: #d55181; --c-work: #008300; --c-other: #8a8f96;
  --wb-neutral: #9aa6b2;
}
`;

export function PeopleTokens() {
  return <style href="people-tokens" precedence="default">{css}</style>;
}
