import { SCAFFOLD_OK } from "@revive/core"
import { Button } from "@/components/ui/button"

export default function App() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-50">
      <h1 className="text-2xl font-semibold text-neutral-900">Revive</h1>
      <p className="text-sm text-neutral-500">
        Scaffold {SCAFFOLD_OK ? "OK" : "FAILED"}
      </p>
      <Button>Test button</Button>
    </div>
  )
}
