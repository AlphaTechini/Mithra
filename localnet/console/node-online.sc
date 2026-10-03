// Brings a LocalNet participant that was taken offline with node-offline.sc back: it reconnects to
// every synchronizer it is registered with and resumes confirming transactions.
// The participant name comes from MITHRA_PARTICIPANT (app-provider | app-user | sv).
//
// VERIFY ON OWNER'S MACHINE: `synchronizers.reconnect_all()` and `synchronizers.list_connected()` are
// the Canton 3.5 console command names as best known; see the note in node-offline.sc.

val participantName = sys.env.getOrElse("MITHRA_PARTICIPANT", sys.error("MITHRA_PARTICIPANT is not set"))

val target = participantName match {
  case "app-provider" => `app-provider`
  case "app-user"     => `app-user`
  case "sv"           => `sv`
  case other          => sys.error(s"unknown participant '$other' (expected app-provider, app-user or sv)")
}

println(s"[mithra] reconnecting $participantName to all synchronizers")
target.synchronizers.reconnect_all()
println(s"[mithra] $participantName connected synchronizers now: " + target.synchronizers.list_connected())
