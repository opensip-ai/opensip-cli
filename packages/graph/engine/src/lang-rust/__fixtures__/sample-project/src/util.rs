// Utility module.

pub fn helper(value: &str) -> String {
    format!("helper:{}", value)
}

pub struct Greeter {
    prefix: String,
}

impl Greeter {
    pub fn new(prefix: &str) -> Self {
        Greeter { prefix: prefix.to_string() }
    }

    pub fn greet(&self, who: i32) -> String {
        format!("{} {}", self.prefix, who)
    }
}

pub fn make_adder() -> impl Fn(i32) -> i32 {
    let inc = |n: i32| n + 1;
    inc
}
