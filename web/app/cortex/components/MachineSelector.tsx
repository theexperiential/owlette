'use client';

import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Monitor, Globe } from 'lucide-react';

export const SITE_TARGET_ID = '__site__';

interface Machine {
  id: string;
  name: string;
  online: boolean;
}

interface MachineSelectorProps {
  machines: Machine[];
  selectedMachineId: string;
  onSelect: (machineId: string) => void;
}

export function MachineSelector({ machines, selectedMachineId, onSelect }: MachineSelectorProps) {
  const isSiteMode = selectedMachineId === SITE_TARGET_ID;
  const selectedMachine = !isSiteMode ? machines.find((m) => m.id === selectedMachineId) : null;
  const onlineCount = machines.filter((m) => m.online).length;

  return (
    <Select value={selectedMachineId} onValueChange={onSelect}>
      <SelectTrigger className="w-[220px] bg-secondary border-border text-foreground">
        <div className="flex items-center gap-2">
          {isSiteMode ? (
            <Globe className="h-4 w-4 text-muted-foreground" />
          ) : (
            <Monitor className="h-4 w-4 text-muted-foreground" />
          )}
          <SelectValue placeholder="select target">
            {isSiteMode ? (
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-accent-cyan" />
                All Machines
                <span className="text-xs text-muted-foreground">({onlineCount})</span>
              </span>
            ) : selectedMachine ? (
              <span className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${selectedMachine.online ? 'bg-green-500' : 'bg-red-500'}`}
                />
                {selectedMachine.name}
              </span>
            ) : null}
          </SelectValue>
        </div>
      </SelectTrigger>
      <SelectContent className="bg-secondary border-border">
        {/* Site-wide option */}
        <SelectItem
          value={SITE_TARGET_ID}
          className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer"
        >
          <span className="flex items-center gap-2">
            <Globe className="h-3.5 w-3.5 text-accent-cyan" />
            All Machines
            <span className="text-xs text-muted-foreground">({onlineCount} online)</span>
          </span>
        </SelectItem>

        {/* Individual machines */}
        {machines.map((machine) => (
          <SelectItem
            key={machine.id}
            value={machine.id}
            className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${machine.online ? 'bg-green-500' : 'bg-red-500'}`}
              />
              {machine.name}
              {!machine.online && (
                <span className="text-xs text-muted-foreground">(offline)</span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
