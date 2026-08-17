import type { ReactNode } from 'react';

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
  /** When set, the visible content is the icon and this becomes the accessible name. */
  iconOnly?: boolean;
};

type SegmentedControlProps<T extends string> = {
  label: string;
  value: T;
  options: SegmentedOption<T>[];
  disabled?: boolean;
  onChange: (value: T) => void;
};

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    <div aria-label={label} className="ui-segmented" role="group">
      {options.map((option) => (
        <button
          aria-label={option.iconOnly ? option.label : undefined}
          aria-pressed={value === option.value}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          title={option.iconOnly ? option.label : undefined}
          type="button"
        >
          {option.icon}
          {!option.iconOnly && <span>{option.label}</span>}
        </button>
      ))}
    </div>
  );
}
