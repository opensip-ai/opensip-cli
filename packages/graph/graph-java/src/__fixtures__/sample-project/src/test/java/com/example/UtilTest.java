// Integration test exercising Util.helper.
package com.example;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

public class UtilTest {
    @Test
    public void helperPrependsPrefix() {
        assertEquals("helper:ok", Util.helper("ok"));
    }

    @Test
    public void helperHandlesEmptyString() {
        assertEquals("helper:", Util.helper(""));
    }
}
