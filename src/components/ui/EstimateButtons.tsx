"use client";
import { Button } from "@/components/ui/Button";

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
          <Button variant="toggle" size="sm" active={active}
            key={minutes}
            onClick={() => onChange(minutes)}>
            {minutes}
          </Button>
        );
      })}
    </div>
  );
}
