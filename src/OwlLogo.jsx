/** OmniScout mark: a small minimal owl, drawn like the lucide icons it sits beside (24px grid, currentColor stroke). */
export default function OwlLogo({ size = 24, className = '' }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 4l3 2.5h6L18 4v9a6 6 0 0 1-12 0z" />
      <circle cx="9.5" cy="10.5" r="2" />
      <circle cx="14.5" cy="10.5" r="2" />
      <path d="M11.2 13.4l.8 1.1.8-1.1" />
      <path d="M10 19v2M14 19v2" />
    </svg>
  );
}
