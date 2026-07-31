import { NavLink, Navigate, Route, Routes } from "react-router-dom"
import { QueuePage } from "@/features/queue/QueuePage"
import { cn } from "@/lib/utils"

function Sidebar() {
  return (
    <nav className="w-44 shrink-0 border-r border-neutral-200 bg-white p-4">
      <p className="mb-4 text-sm font-semibold text-neutral-900">Revive</p>
      <NavLink
        to="/queue"
        className={({ isActive }: { isActive: boolean }) =>
          cn(
            "block rounded-md px-2 py-1.5 text-sm",
            isActive
              ? "bg-neutral-100 font-medium text-neutral-900"
              : "text-neutral-600 hover:bg-neutral-50",
          )
        }
      >
        Queue
      </NavLink>
      {/* /leads/:id is task 14 — no lead is selected from here yet. */}
      <span className="mt-1 block cursor-default rounded-md px-2 py-1.5 text-sm text-neutral-400">
        Leads
      </span>
    </nav>
  )
}

export default function App() {
  return (
    <div className="flex min-h-screen bg-neutral-50">
      <Sidebar />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Navigate to="/queue" replace />} />
          <Route path="/queue" element={<QueuePage />} />
        </Routes>
      </main>
    </div>
  )
}
