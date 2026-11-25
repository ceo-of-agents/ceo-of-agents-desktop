// The brand's flat logo mark (org tree: you above the chief of staff, three branches landing as commits on the hq line).
// Geometry is fixed by the brand: do not edit, recolour, stretch or animate it. Colours come from the palette tokens.
// Use only on ink or surface, at 32 px tall or more.
export function LogoMark({ size, className }: { size: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="220 223 584 584" aria-hidden="true" focusable="false">
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth={24}>
        <g stroke="var(--connector)">
          <path d="M512 362 L512 434" />
          <path d="M512 558 C512 636 312 612 312 688" />
          <path d="M512 558 L512 688" />
          <path d="M512 558 C512 636 712 612 712 688" />
        </g>
        <g stroke="var(--teal)">
          <path d="M232 736 L266 736" />
          <path d="M358 736 L466 736" />
          <path d="M558 736 L666 736" />
          <path d="M758 736 L792 736" />
          <circle cx="312" cy="736" r="44" />
          <circle cx="512" cy="736" r="44" />
          <circle cx="712" cy="736" r="44" />
        </g>
        <circle cx="512" cy="496" r="62" fill="var(--teal)" stroke="none" />
        <circle cx="512" cy="300" r="62" fill="var(--violet)" stroke="none" />
      </g>
    </svg>
  );
}
