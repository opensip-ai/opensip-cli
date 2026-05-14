// Sample Java source for multi-language fitness checks.
public class Sample {
    public static void main(String[] args) {
        try {
            doWork();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private static void doWork() throws Exception {
        // TODO: implement work
        throw new Exception("nope");
    }
}
