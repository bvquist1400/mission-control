"use client";

const DEFAULT_OPTIONS = [15, 30, 60, 90, 120] as const;

interface EstimateButtonsProps {
  value: number;
  onChange: (minutes: number) => void;
  options?: readonly number[];
}

export function EstimateButtons({ value, onChange, options = DEFAULT_OPTIONS }: EstimateButtonsProps) {
  return (
    <div className="inline-flex rounded-lg border border-stroke bg-panel-muted p-1">
      {options.map((minutes) => {
        const active = minutes === value;

        return (
          <button
            key={minutes}
            type="button"
            onClick={() => onChange(minutes)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
              active ? "bg-accent text-white shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {minutes}
          </button>
        );
      })}
    </div>
  );
}
