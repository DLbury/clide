use portable_pty::ChildKiller;
use std::sync::mpsc::Sender;

pub struct TerminalChannels {
    pub write_tx: Sender<Vec<u8>>,
    pub resize_tx: Sender<(u16, u16)>,
    /// Local/WSL PTY shell killer. SSH/Telnet/serial leave this empty.
    pub child_killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}
