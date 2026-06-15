import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

class OrderService {
    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    void process(Throwable e) {
        log.error("order processing failed", e);
    }
}
