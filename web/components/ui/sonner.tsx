"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ theme, ...props }: ToasterProps) => {
  const { theme: systemTheme = "system" } = useTheme()

  return (
    <Sonner
      theme={(theme || systemTheme) as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast: "bg-slate-800 border-slate-700 text-white",
          title: "text-white font-medium",
          description: "text-slate-300",
          actionButton: "bg-accent-cyan text-gray-900 hover:bg-accent-cyan-hover",
          cancelButton: "bg-slate-700 text-white hover:bg-slate-600",
          closeButton: "bg-slate-700 text-white hover:bg-slate-600",
          error: "bg-red-900/90 border-red-700 text-white",
          success: "bg-green-900/90 border-green-700 text-white",
          warning: "bg-yellow-900/90 border-yellow-700 text-white",
          info: "bg-accent-cyan/15 border-accent-cyan/30 text-white",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
