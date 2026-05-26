use std::sync::mpsc::Sender;

pub struct TerminalChannels {
    pub write_tx: Sender<Vec<u8>>,
    pub resize_tx: Sender<(u16, u16)>,
}
