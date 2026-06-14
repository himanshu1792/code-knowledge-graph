package com.example.demo.controller;

import com.example.demo.service.OrderService;
import com.example.demo.service.DiscountService;
import com.example.demo.model.Order;
import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;
    private final DiscountService discountService;

    public OrderController(OrderService orderService, DiscountService discountService) {
        this.orderService = orderService;
        this.discountService = discountService;
    }

    @GetMapping("/sorted")
    public List<Order> sorted() {
        return orderService.sortedByAmountDescending();
    }

    @GetMapping("/discount/{tier}")
    public double discount(@PathVariable String tier) {
        return discountService.rateFor(tier);
    }
}
