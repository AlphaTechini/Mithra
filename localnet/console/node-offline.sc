// Takes one LocalNet participant "offline" for the BitSafe demo: it disconnects from every
// synchronizer, so it stops confirming transactions. The participant process and its database stay up.
// The participant name comes from MITHRA_PARTICIPANT (app-provider | app-user | sv).
//
// VERIFY ON OWNER'S MACHINE: the console command names below (`synchronizers.disconnect_all()`,
// `synchronizers.list_connected()`) come from the Canton 3.5 console reference, which was not
// reachable when this was written. If a command is not found, run
//   scripts/localnet-node.sh console   (opens the stock interactive Canton console) and type
//   `app-user`.synchronizers.<TAB>
// to see the exact names, then fix them here and in node-online.sc.

val participantName = sys.env.getOrElse("MITHRA_PARTICIPANT", sys.error("MITHRA_PARTICIPANT is not set"))

// Participants are remote participants named app-provider, app-user and sv (Scala identifiers need
// backticks because of the hyphen), see /app/app.conf in the console container.
val target = participantName match {
  case "app-provider" => `app-provider`
  case "app-user"     => `app-user`
  case "sv"           => `sv`
  case other          => sys.error(s"unknown participant '$other' (expected app-provider, app-user or sv)")
}

println(s"[mithra] disconnecting $participantName from all synchronizers")
target.synchronizers.disconnect_all()
println(s"[mithra] $participantName connected synchronizers now: " + target.synchronizers.list_connected())
