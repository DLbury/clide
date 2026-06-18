/// 将 PTY 分块读出的字节流解码为 UTF-8 字符串，避免多字节字符或 ANSI 序列被截断。
pub struct Utf8ChunkDecoder {
    pending: Vec<u8>,
}

impl Utf8ChunkDecoder {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    pub fn decode(&mut self, chunk: &[u8]) -> String {
        if chunk.is_empty() {
            return String::new();
        }
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    out.push_str(valid);
                    self.pending.clear();
                    break;
                }
                Err(e) => {
                    let valid_up_to = e.valid_up_to();
                    if valid_up_to > 0 {
                        if let Ok(part) = std::str::from_utf8(&self.pending[..valid_up_to]) {
                            out.push_str(part);
                        }
                        self.pending.drain(..valid_up_to);
                    }
                    match e.error_len() {
                        Some(invalid_len) => {
                            let skip = invalid_len.min(self.pending.len());
                            self.pending.drain(..skip);
                        }
                        None => break,
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_multibyte_across_reads() {
        let mut dec = Utf8ChunkDecoder::new();
        let s = "中文abc";
        let bytes = s.as_bytes();
        let mid = bytes.len() - 2;
        assert_eq!(dec.decode(&bytes[..mid]), "中文a");
        assert_eq!(dec.decode(&bytes[mid..]), "bc");
        assert_eq!(dec.decode(&[]), "");
    }
}
