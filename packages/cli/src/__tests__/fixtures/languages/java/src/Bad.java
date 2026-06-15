public class Bad {
    public void run() {
        try {
            doWork();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void doWork() throws Exception {
    }
}
