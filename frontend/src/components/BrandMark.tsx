export function BrandMark({ className = '' }: { className?: string }) {
  return <svg aria-hidden="true" className={className} height={48} viewBox="0 0 48 48" width={48} fill="currentColor">
    <g transform="translate(6 4) scale(1.125)">
      <path d="M14 5h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4h-1v-9a5 5 0 0 0-5-5h-8a4 4 0 0 1 4-4Z" opacity=".35" />
      <path d="M8 10h10a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-5l-5 4v-4a4 4 0 0 1-4-4v-8a4 4 0 0 1 4-4ZM9 15v2h8v-2H9Zm0 5v2h5v-2H9Z" fillRule="evenodd" />
    </g>
  </svg>;
}
