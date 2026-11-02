//! AMF0, the little data format RTMP commands are written in: numbers, strings, booleans, objects
//! and arrays, each with a one-byte type marker in front. Only what RTMP publishing needs, but
//! both ways: we write `connect` and `publish`, and read the server's `_result` and `onStatus`.

use crate::error::{Error, Result};

const NUMBER: u8 = 0x00;
const BOOLEAN: u8 = 0x01;
const STRING: u8 = 0x02;
const OBJECT: u8 = 0x03;
const NULL: u8 = 0x05;
const UNDEFINED: u8 = 0x06;
const ECMA_ARRAY: u8 = 0x08;
const OBJECT_END: u8 = 0x09;
const STRICT_ARRAY: u8 = 0x0A;
const DATE: u8 = 0x0B;
const LONG_STRING: u8 = 0x0C;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Number(f64),
    Boolean(bool),
    String(String),
    /// Named values, kept in the order they were written.
    Object(Vec<(String, Value)>),
    EcmaArray(Vec<(String, Value)>),
    StrictArray(Vec<Value>),
    Null,
    Undefined,
    /// Milliseconds since 1970 (the time zone field is read and dropped).
    Date(f64),
}

impl Value {
    pub fn string(text: &str) -> Value {
        Value::String(text.to_string())
    }

    pub fn object(pairs: &[(&str, Value)]) -> Value {
        Value::Object(pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect())
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            _ => None,
        }
    }

    /// The named value of an object or array.
    pub fn get(&self, name: &str) -> Option<&Value> {
        match self {
            Value::Object(pairs) | Value::EcmaArray(pairs) => pairs.iter().find(|(k, _)| k == name).map(|(_, v)| v),
            _ => None,
        }
    }
}

fn put_name(out: &mut Vec<u8>, name: &str) {
    let bytes = name.as_bytes();
    let len = bytes.len().min(u16::MAX as usize);
    out.extend_from_slice(&(len as u16).to_be_bytes());
    out.extend_from_slice(&bytes[..len]);
}

fn put_pairs(out: &mut Vec<u8>, pairs: &[(String, Value)]) {
    for (name, value) in pairs {
        put_name(out, name);
        encode_into(out, value);
    }
    out.extend_from_slice(&[0, 0, OBJECT_END]);
}

/// Appends the AMF0 form of `value` to `out`.
pub fn encode_into(out: &mut Vec<u8>, value: &Value) {
    match value {
        Value::Number(n) => {
            out.push(NUMBER);
            out.extend_from_slice(&n.to_be_bytes());
        }
        Value::Boolean(b) => out.extend_from_slice(&[BOOLEAN, u8::from(*b)]),
        Value::String(s) if s.len() <= u16::MAX as usize => {
            out.push(STRING);
            put_name(out, s);
        }
        Value::String(s) => {
            out.push(LONG_STRING);
            out.extend_from_slice(&(s.len() as u32).to_be_bytes());
            out.extend_from_slice(s.as_bytes());
        }
        Value::Object(pairs) => {
            out.push(OBJECT);
            put_pairs(out, pairs);
        }
        Value::EcmaArray(pairs) => {
            out.push(ECMA_ARRAY);
            out.extend_from_slice(&(pairs.len() as u32).to_be_bytes());
            put_pairs(out, pairs);
        }
        Value::StrictArray(items) => {
            out.push(STRICT_ARRAY);
            out.extend_from_slice(&(items.len() as u32).to_be_bytes());
            for item in items {
                encode_into(out, item);
            }
        }
        Value::Null => out.push(NULL),
        Value::Undefined => out.push(UNDEFINED),
        Value::Date(ms) => {
            out.push(DATE);
            out.extend_from_slice(&ms.to_be_bytes());
            out.extend_from_slice(&[0, 0]);
        }
    }
}

/// All of `values` back to back, as one RTMP command or data message payload.
pub fn encode(values: &[Value]) -> Vec<u8> {
    let mut out = Vec::new();
    for value in values {
        encode_into(&mut out, value);
    }
    out
}

struct Cursor<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.data.len() - self.at < n {
            return Err(Error::new("The server sent a command that was cut short."));
        }
        let slice = &self.data[self.at..self.at + n];
        self.at += n;
        Ok(slice)
    }

    fn u16(&mut self) -> Result<usize> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]) as usize)
    }

    fn u32(&mut self) -> Result<u32> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn f64(&mut self) -> Result<f64> {
        let b = self.take(8)?;
        Ok(f64::from_be_bytes(b.try_into().expect("eight bytes")))
    }

    fn text(&mut self, len: usize) -> Result<String> {
        Ok(String::from_utf8_lossy(self.take(len)?).into_owned())
    }

    fn pairs(&mut self, depth: usize) -> Result<Vec<(String, Value)>> {
        let mut pairs = Vec::new();
        loop {
            let len = self.u16()?;
            if len == 0 && self.data.get(self.at) == Some(&OBJECT_END) {
                self.at += 1;
                return Ok(pairs);
            }
            let name = self.text(len)?;
            pairs.push((name, self.value(depth + 1)?));
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value> {
        if depth > 16 {
            return Err(Error::new("The server sent a command nested too deeply."));
        }
        let marker = self.take(1)?[0];
        Ok(match marker {
            NUMBER => Value::Number(self.f64()?),
            BOOLEAN => Value::Boolean(self.take(1)?[0] != 0),
            STRING => {
                let len = self.u16()?;
                Value::String(self.text(len)?)
            }
            LONG_STRING => {
                let len = self.u32()? as usize;
                Value::String(self.text(len)?)
            }
            OBJECT => Value::Object(self.pairs(depth)?),
            ECMA_ARRAY => {
                self.u32()?; // the count is only a hint; the end marker is what counts
                Value::EcmaArray(self.pairs(depth)?)
            }
            STRICT_ARRAY => {
                let count = self.u32()? as usize;
                let mut items = Vec::new();
                for _ in 0..count.min(4096) {
                    items.push(self.value(depth + 1)?);
                }
                Value::StrictArray(items)
            }
            NULL => Value::Null,
            UNDEFINED => Value::Undefined,
            DATE => {
                let ms = self.f64()?;
                self.take(2)?;
                Value::Date(ms)
            }
            other => return Err(Error::new(format!("The server sent a command with a type Uncbox doesn't know (0x{other:02X})."))),
        })
    }
}

/// Reads every value in `data` (a command is a name, a transaction number, then arguments).
pub fn decode(data: &[u8]) -> Result<Vec<Value>> {
    let mut cursor = Cursor { data, at: 0 };
    let mut values = Vec::new();
    while cursor.at < data.len() {
        values.push(cursor.value(0)?);
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_basic_types() {
        assert_eq!(encode(&[Value::Number(1.0)]), [0x00, 0x3F, 0xF0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(encode(&[Value::Boolean(true), Value::Boolean(false)]), [0x01, 1, 0x01, 0]);
        assert_eq!(encode(&[Value::string("app")]), [0x02, 0, 3, b'a', b'p', b'p']);
        assert_eq!(encode(&[Value::Null, Value::Undefined]), [0x05, 0x06]);
    }

    #[test]
    fn writes_objects_with_an_end_marker() {
        let bytes = encode(&[Value::object(&[("a", Value::Number(2.0)), ("b", Value::string("x"))])]);
        assert_eq!(bytes[0], 0x03);
        assert_eq!(&bytes[1..4], &[0, 1, b'a']);
        assert_eq!(&bytes[bytes.len() - 3..], &[0, 0, 0x09]);
    }

    #[test]
    fn writes_ecma_arrays_with_their_count() {
        let bytes = encode(&[Value::EcmaArray(vec![("w".into(), Value::Number(1920.0)), ("h".into(), Value::Number(1080.0))])]);
        assert_eq!(&bytes[..5], &[0x08, 0, 0, 0, 2]);
        assert_eq!(&bytes[bytes.len() - 3..], &[0, 0, 0x09]);
    }

    #[test]
    fn long_strings_get_the_long_marker() {
        let long = "x".repeat(70_000);
        let bytes = encode(&[Value::String(long.clone())]);
        assert_eq!(bytes[0], 0x0C);
        assert_eq!(u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]), 70_000);
        assert_eq!(decode(&bytes).unwrap(), vec![Value::String(long)]);
    }

    #[test]
    fn reads_back_what_it_writes() {
        let command = vec![
            Value::string("connect"),
            Value::Number(1.0),
            Value::object(&[
                ("app", Value::string("app")),
                ("type", Value::string("nonprivate")),
                ("nested", Value::object(&[("deep", Value::Boolean(true))])),
            ]),
            Value::Null,
            Value::EcmaArray(vec![("duration".into(), Value::Number(0.0))]),
            Value::StrictArray(vec![Value::Number(1.0), Value::string("two"), Value::Undefined]),
            Value::Date(1_700_000_000_000.0),
        ];
        assert_eq!(decode(&encode(&command)).unwrap(), command);
    }

    #[test]
    fn reads_what_a_server_sends() {
        // _result, 1, null, { fmsVer: "FMS" }: the shape of a server's answer to connect.
        let mut bytes = vec![0x02, 0, 7];
        bytes.extend_from_slice(b"_result");
        bytes.extend_from_slice(&[0x00, 0x3F, 0xF0, 0, 0, 0, 0, 0, 0, 0x05, 0x03, 0, 6]);
        bytes.extend_from_slice(b"fmsVer");
        bytes.extend_from_slice(&[0x02, 0, 3]);
        bytes.extend_from_slice(b"FMS");
        bytes.extend_from_slice(&[0, 0, 0x09]);
        let values = decode(&bytes).unwrap();
        assert_eq!(values[0].as_str(), Some("_result"));
        assert_eq!(values[1].as_number(), Some(1.0));
        assert_eq!(values[2], Value::Null);
        assert_eq!(values[3].get("fmsVer").and_then(Value::as_str), Some("FMS"));
        assert_eq!(values[3].get("missing"), None);
    }

    #[test]
    fn refuses_cut_short_and_unknown_data() {
        assert!(decode(&[0x02, 0, 9, b'a']).is_err());
        assert!(decode(&[0x00, 1, 2]).is_err());
        assert!(decode(&[0x7F]).is_err());
        assert!(decode(&[0x03, 0, 1, b'a']).is_err());
        assert_eq!(decode(&[]).unwrap(), vec![]);
    }

    #[test]
    fn refuses_endless_nesting() {
        let mut bytes = Vec::new();
        for _ in 0..40 {
            bytes.extend_from_slice(&[0x03, 0, 1, b'a']);
        }
        assert!(decode(&bytes).is_err());
    }
}
